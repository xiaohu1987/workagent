import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { SchedulerService, describeSchedule } from "../apps/desktop/src/main/scheduler-service";
import type { SchedulerRunKind, SchedulerTask } from "@shared-types";

function createService(overrides?: Partial<ConstructorParameters<typeof SchedulerService>[0]>) {
  const executed: Array<{ task: SchedulerTask; kind: SchedulerRunKind }> = [];
  const emissions: number[] = [];
  const service = new SchedulerService({
    dataDir: "tmp/scheduler-test-unit",
    exec: async (task, kind) => {
      executed.push({ task, kind });
      return { threadId: "thread-1", ok: true };
    },
    emit: () => {
      emissions.push(Date.now());
    },
    ...overrides
  });
  return { service, executed, emissions };
}

describe("SchedulerService", () => {
  it("creates a daily task and computes the next run in the future", () => {
    const { service } = createService();
    const task = service.upsertTask({ name: "每日新闻", prompt: "推送今日新闻", scheduleType: "daily", time: "09:00" });
    expect(task.enabled).toBe(true);
    expect(task.nextRunAt).toBeTruthy();
    expect(Date.parse(task.nextRunAt!)).toBeGreaterThan(Date.now());
    expect(task.nextRunAt!.endsWith("01:00.000Z") || task.nextRunAt!.endsWith("00:00.000Z")).toBe(true);
    expect(describeSchedule(task)).toBe("每天 09:00");
  });

  it("rejects tasks without a name or prompt", () => {
    const { service } = createService();
    expect(() => service.upsertTask({ name: "  ", prompt: "x" })).toThrow();
    expect(() => service.upsertTask({ name: "x", prompt: "" })).toThrow();
  });

  it("computes the next weekly run on the requested weekday", () => {
    const { service } = createService();
    const task = service.upsertTask({ name: "周报", prompt: "写周报", scheduleType: "weekly", weekday: 1, time: "20:00" });
    const next = new Date(task.nextRunAt!);
    expect(next.getDay()).toBe(1);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(describeSchedule(task)).toBe("每周一 20:00");
  });

  it("pausing clears the schedule and re-enabling recomputes it", () => {
    const { service } = createService();
    const task = service.upsertTask({ name: "巡检", prompt: "巡检", scheduleType: "daily", time: "23:00" });
    const paused = service.setEnabled(task.id, false);
    expect(paused.enabled).toBe(false);
    expect(paused.nextRunAt).toBeNull();
    const resumed = service.setEnabled(task.id, true);
    expect(resumed.enabled).toBe(true);
    expect(resumed.nextRunAt).toBeTruthy();
  });

  it("handleManage supports the list/create/delete round trip", async () => {
    const { service } = createService();
    const created = await service.handleManage({
      action: "create",
      name: "备份",
      prompt: "执行备份",
      scheduleType: "daily",
      time: "07:30"
    });
    expect(created.ok).toBe(true);
    const list = await service.handleManage({ action: "list" });
    expect(list.content).toContain("备份");
    const listed = service.listTasks();
    expect(listed).toHaveLength(1);
    const removed = await service.handleManage({ action: "delete", id: listed[0].id });
    expect(removed.ok).toBe(true);
    expect(service.listTasks()).toHaveLength(0);
  });

  it("runNow records a test run through the exec callback", async () => {
    const { service, executed } = createService();
    const task = service.upsertTask({ name: "冒烟", prompt: "冒烟", scheduleType: "daily", time: "23:59" });
    service.runNow(task.id);
    // 执行链是异步排队的，等一拍让它跑完。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executed).toHaveLength(1);
    expect(executed[0].kind).toBe("test");
    const state = service.getState();
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].status).toBe("test_success");
    expect(state.runs[0].threadId).toBe("thread-1");
  });

  it("once tasks auto-disable after firing and do not reschedule", async () => {
    const { service, executed } = createService();
    const past = new Date(Date.now() - 60_000);
    const task = service.upsertTask({
      name: "一次性",
      prompt: "一次性任务",
      scheduleType: "once",
      time: "08:00",
      runAt: past.toISOString()
    });
    // 计划时间已过：不排程，也不会触发。
    expect(task.nextRunAt).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executed).toHaveLength(0);
  });

  it("a task missed while the app was off fires once as catchup on startup", async () => {
    const dataDir = "tmp/scheduler-test-catchup";
    const missed = new Date(Date.now() - 5 * 60_000).toISOString();
    await seedTasksFile(dataDir, [{ ...baseTask(), nextRunAt: missed }]);
    const executed: Array<{ id: string; kind: SchedulerRunKind }> = [];
    const service = new SchedulerService({
      dataDir,
      exec: async (task, kind) => {
        executed.push({ id: task.id, kind });
        return { threadId: "thread-1", ok: true };
      },
      emit: () => undefined
    });
    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    service.stop();
    // 停摆期间错过的这次要补跑一次，且标记为 catchup。
    expect(executed).toEqual([{ id: "seed-1", kind: "catchup" }]);
    const state = service.getState();
    expect(state.runs[0]?.status).toBe("catchup_success");
    const next = service.listTasks()[0]?.nextRunAt;
    expect(next).toBeTruthy();
    expect(Date.parse(next!)).toBeGreaterThan(Date.now());
  });

  it("a task that went past-due between ticks still fires on the next tick", async () => {
    const dataDir = "tmp/scheduler-test-pastdue";
    // 过期 30 秒：晚于「启动时刻 - 1 分钟」边界，按 scheduled 记。
    const pastDue = new Date(Date.now() - 30_000).toISOString();
    await seedTasksFile(dataDir, [{ ...baseTask(), nextRunAt: pastDue }]);
    const executed: Array<{ id: string; kind: SchedulerRunKind }> = [];
    const service = new SchedulerService({
      dataDir,
      exec: async (task, kind) => {
        executed.push({ id: task.id, kind });
        return { threadId: "thread-1", ok: true };
      },
      emit: () => undefined
    });
    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    service.stop();
    expect(executed).toEqual([{ id: "seed-1", kind: "scheduled" }]);
    expect(service.getState().runs[0]?.status).toBe("success");
  });
});

function baseTask(): SchedulerTask {
  const now = new Date().toISOString();
  return {
    id: "seed-1",
    name: "种子任务",
    prompt: "p",
    scheduleType: "daily",
    time: "23:59",
    enabled: true,
    validUntil: null,
    createdAt: now,
    updatedAt: now,
    nextRunAt: null,
    lastRunAt: null
  };
}

async function seedTasksFile(dataDir: string, tasks: SchedulerTask[]): Promise<void> {
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(`${dataDir}/tasks.json`, JSON.stringify({ version: 1, tasks }, null, 2), "utf8");
}
