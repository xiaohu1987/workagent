import { createElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MutableRefObject, ReactNode } from "react";
import type { ContextCompactionRecord, GptReasoningEffort } from "@shared-types";
import { GPT_REASONING_EFFORTS } from "@shared-types";
import type { ContextUsage } from "../lib/conversation-utils";
import { IconChevronDown, IconChevronRight, IconClose, IconImage } from "../icons";
import type { ComposerSelectOption } from "../workspace/composer-select";
import { formatTokenCount } from "../workspace/usage-stats";
import { useMotionPresence } from "../core/motion-presence";
const GPT_REASONING_EFFORT_LABELS: Record<GptReasoningEffort, string> = {
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高"
};

export function ReasoningEffortPicker({
  value,
  onChange,
  disabled
}: {
  value: GptReasoningEffort;
  onChange: (value: GptReasoningEffort) => void;
  disabled: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuPresence = useMotionPresence(isOpen ? true : null, 140);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (disabled && isOpen) setIsOpen(false);
  }, [disabled, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={rootRef} className={`reasoning-effort-picker ${isOpen ? "open" : ""}`}>
      <button
        type="button"
        className="reasoning-effort-trigger"
        onClick={() => !disabled && setIsOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={`推理强度：${GPT_REASONING_EFFORT_LABELS[value]}`}
        title="推理强度"
        disabled={disabled}
      >
        <span>推理 · {GPT_REASONING_EFFORT_LABELS[value]}</span>
        <span className="composer-select-chevron" aria-hidden="true"><IconChevronDown /></span>
      </button>
      {menuPresence.value ? (
        <div className="reasoning-effort-menu" data-motion={menuPresence.phase} role="listbox" aria-label="推理强度">
          <div className="reasoning-effort-title">推理强度</div>
          {GPT_REASONING_EFFORTS.map((effort) => (
            <button
              key={effort}
              type="button"
              className={`reasoning-effort-option ${effort === value ? "selected" : ""}`}
              onClick={() => {
                onChange(effort);
                setIsOpen(false);
              }}
              role="option"
              aria-selected={effort === value}
            >
              <span>{GPT_REASONING_EFFORT_LABELS[effort]}</span>
              {effort === value ? <span className="reasoning-effort-check" aria-hidden="true">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export type ComposerModelGroup = {
  providerId: string;
  providerLabel: string;
  models: Array<{ id: string; label: string; supportsMultimodalInput: boolean }>;
};

export function ContextCompactionNotice({ compaction }: { compaction: ContextCompactionRecord }) {
  return (
    <details className="context-compaction-notice">
      <summary>
        <span className="context-compaction-icon" aria-hidden="true">↳</span>
        <strong>上下文已自动压缩</strong>
        <span>{formatTokenCount(compaction.beforeTokens)} → {formatTokenCount(compaction.afterTokens)}</span>
      </summary>
      <div className="context-compaction-detail">
        <span>消息 {compaction.messagesBefore} → {compaction.messagesAfter}</span>
        <span>占用约 {Math.round((compaction.afterTokens / Math.max(1, compaction.contextWindow)) * 100)}%</span>
        <span>{new Date(compaction.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
    </details>
  );
}

export function ContextUsageControl({
  usage,
  open,
  onToggle,
  onClose
}: {
  usage: ContextUsage;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const reportPresence = useMotionPresence(open ? true : null, 140);
  useEffect(() => {
    if (!open) {
      return;
    }
    const close = () => onClose();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open]);

  return (
    <div className="context-usage-anchor" onPointerDown={(event) => event.stopPropagation()}>
      <button
        type="button"
        className={`context-usage-button ${open ? "is-open" : ""}`}
        aria-label="查看上下文占用"
        aria-expanded={open}
        title={`上下文占用：约 ${usage.percentage}%`}
        onClick={onToggle}
      >
        <span
          className="context-usage-ring"
          style={{ "--context-usage-angle": `${Math.max(3, usage.percentage * 3.6)}deg` } as React.CSSProperties}
        >
          <span>{usage.percentage}%</span>
        </span>
      </button>
      {reportPresence.value ? <ContextUsageReport usage={usage} motionPhase={reportPresence.phase} onClose={onClose} /> : null}
    </div>
  );
}

export function ContextUsageReport({ usage, motionPhase, onClose }: { usage: ContextUsage; motionPhase?: string; onClose: () => void }) {
  return (
    <section className="context-usage-report" data-motion={motionPhase} aria-label="上下文占用详情">
      <header>
        <div>
          <strong>上下文占用</strong>
          <span>{usage.compaction ? "压缩后估算" : "本地估算"}</span>
        </div>
        <button type="button" title="关闭" aria-label="关闭上下文详情" onClick={onClose}>
          <IconClose />
        </button>
      </header>
      <div className="context-usage-summary">
        <span>{usage.percentage}% 已用</span>
        <strong>约 {formatTokenCount(usage.usedTokens)} / {formatTokenCount(usage.contextWindow)} tokens</strong>
      </div>
      {usage.compaction ? (
        <div className="context-usage-compaction">
          <span>压缩前 {formatTokenCount(usage.compaction.beforeTokens)}</span>
          <strong>压缩后 {formatTokenCount(usage.compaction.afterTokens)}</strong>
        </div>
      ) : null}
      <div className="context-usage-bar" aria-hidden="true">
        {usage.segments.map((segment) => (
          <i
            key={segment.id}
            style={{
              width: `${Math.max(usage.contextWindow ? (segment.tokens / usage.contextWindow) * 100 : 0, 0.8)}%`,
              background: segment.color
            }}
          />
        ))}
      </div>
      <div className="context-usage-segments">
        {usage.segments.map((segment) => (
          <div key={segment.id}>
            <span style={{ background: segment.color }} aria-hidden="true" />
            <strong>{segment.label}</strong>
            <em>{formatTokenCount(segment.tokens)}</em>
          </div>
        ))}
      </div>
    </section>
  );
}

export function FloatingSideMenu({
  anchor,
  open,
  width,
  placementKey,
  className,
  children,
  panelRef,
  onMouseEnter,
  onMouseLeave
}: {
  anchor: HTMLElement | null;
  open: boolean;
  width: number;
  placementKey?: string;
  className: string;
  children: ReactNode;
  panelRef?: MutableRefObject<HTMLDivElement | null>;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const localPanelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number; anchorTop: number } | null>(null);
  const viewportMargin = 12;
  const gap = 6;

  useLayoutEffect(() => {
    if (!open || !anchor) {
      setPosition(null);
      return;
    }
    const updatePosition = () => {
      const rect = anchor.getBoundingClientRect();
      const maxHeight = Math.min(380, Math.max(160, window.innerHeight - viewportMargin * 2));
      const opensRight = rect.right + gap + width <= window.innerWidth - viewportMargin;
      setPosition({
        left: opensRight ? rect.right + gap : Math.max(viewportMargin, rect.left - width - gap),
        top: Math.min(Math.max(viewportMargin, rect.top), window.innerHeight - maxHeight - viewportMargin),
        maxHeight,
        anchorTop: rect.top
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [anchor, open, placementKey, width]);

  useLayoutEffect(() => {
    if (!position || !localPanelRef.current) {
      return;
    }
    const actualHeight = localPanelRef.current.getBoundingClientRect().height;
    const top = Math.min(
      Math.max(viewportMargin, position.anchorTop),
      window.innerHeight - actualHeight - viewportMargin
    );
    if (Math.abs(top - position.top) > 1) {
      setPosition((current) => current ? { ...current, top } : current);
    }
  }, [position]);

  if (!open || !position) {
    return null;
  }

  return createPortal(
    <div
      ref={(node) => {
        localPanelRef.current = node;
        if (panelRef) panelRef.current = node;
      }}
      className={`floating-side-menu ${className}`}
      role="menu"
      style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>,
    document.body
  );
}

export function ComposerModelPicker({
  triggerLabel,
  providers,
  modelGroups,
  selectedProviderId,
  selectedModelId,
  onSelectModel,
  disabled
}: {
  triggerLabel: string;
  providers: ComposerSelectOption[];
  modelGroups: ComposerModelGroup[];
  selectedProviderId: string;
  selectedModelId: string;
  onSelectModel: (providerId: string, modelId: string) => void;
  disabled: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuPresence = useMotionPresence(isOpen ? true : null, 140);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [hoveredProviderId, setHoveredProviderId] = useState<string | null>(null);
  const [modelsPanelAnchor, setModelsPanelAnchor] = useState<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const modelsPanelRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);

  const clearHoverTimer = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (disabled && isOpen) {
      setIsOpen(false);
      setActiveProviderId(null);
      setModelsPanelAnchor(null);
    }
  }, [disabled, isOpen]);

  useEffect(() => {
    return () => {
      clearHoverTimer();
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      clearHoverTimer();
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !modelsPanelRef.current?.contains(target)) {
        setIsOpen(false);
        setActiveProviderId(null);
        setHoveredProviderId(null);
        setModelsPanelAnchor(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
        setActiveProviderId(null);
        setHoveredProviderId(null);
        setModelsPanelAnchor(null);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const handleMove = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      const providerItem = target.closest<HTMLElement>(".composer-model-picker-provider");
      if (providerItem) {
        const providerId = providerItem.dataset.providerId;
        if (providerId) {
          handleProviderHover(providerId, providerItem);
          return;
        }
      }
      const modelItem = target.closest<HTMLElement>(".composer-model-picker-model");
      if (modelItem) {
        clearHoverTimer();
        return;
      }
    };
    root.addEventListener("mousemove", handleMove);
    return () => {
      root.removeEventListener("mousemove", handleMove);
    };
  }, [isOpen]);

  if (providers.length === 0) {
    return (
      <div ref={rootRef} className="composer-model-picker disabled">
        <span className="composer-model-picker-label">选择模型</span>
      </div>
    );
  }

  const openMenu = (initialProviderId: string | null) => {
    clearHoverTimer();
    setIsOpen(true);
    setActiveProviderId(initialProviderId);
    setHoveredProviderId(null);
    setModelsPanelAnchor(null);
  };

  const handleProviderHover = (providerId: string, providerItem?: HTMLElement) => {
    clearHoverTimer();
    setHoveredProviderId(providerId);
    if (providerItem) setModelsPanelAnchor(providerItem);
  };

  const handleProviderLeave = () => {
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      setHoveredProviderId(null);
    }, 160);
  };

  const handleModelPanelEnter = () => {
    clearHoverTimer();
  };

  const handleModelPanelLeave = () => {
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      setHoveredProviderId(null);
    }, 180);
  };

  const visibleSecondaryProviderId = hoveredProviderId ?? activeProviderId;
  const visibleSecondaryProvider = providers.find((provider) => provider.value === visibleSecondaryProviderId);

  return (
    <div
      ref={rootRef}
      className={`composer-model-picker ${isOpen ? "open" : ""} ${disabled ? "disabled" : ""}`}
    >
      <button
        type="button"
        className="composer-model-picker-trigger"
        onClick={() => {
          if (disabled) {
            return;
          }
          if (isOpen) {
            setIsOpen(false);
            setActiveProviderId(null);
            setHoveredProviderId(null);
            setModelsPanelAnchor(null);
            return;
          }
          openMenu(null);
        }}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        disabled={disabled}
        title="选择模型"
      >
        <span className="composer-model-picker-label">{triggerLabel}</span>
        <span className="composer-select-chevron">
          <IconChevronRight />
        </span>
      </button>

      {menuPresence.value ? (
        <div className="composer-model-picker-menu" data-motion={menuPresence.phase} role="listbox">
          <ul
            className="composer-model-picker-providers"
            onMouseLeave={handleProviderLeave}
          >
            {providers.map((provider) => (
              <li key={provider.value}>
                <button
                  type="button"
                  data-provider-id={provider.value}
                  className={`composer-model-picker-provider ${visibleSecondaryProviderId === provider.value ? "is-active" : ""}`}
                  onClick={(event) => {
                    setActiveProviderId(provider.value);
                    handleProviderHover(provider.value, event.currentTarget);
                  }}
                  onMouseEnter={(event) => handleProviderHover(provider.value, event.currentTarget)}
                  onFocus={(event) => {
                    setActiveProviderId(provider.value);
                    handleProviderHover(provider.value, event.currentTarget);
                  }}
                  role="option"
                  aria-selected={selectedProviderId === provider.value}
                >
                  <span>{provider.label}</span>
                  <span className="composer-model-picker-chevron">
                    <IconChevronRight />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {visibleSecondaryProviderId && modelsPanelAnchor ? (
            <FloatingSideMenu
              anchor={modelsPanelAnchor}
              open={isOpen}
              width={264}
              placementKey={visibleSecondaryProviderId}
              className="composer-model-picker-models"
              panelRef={modelsPanelRef}
              onMouseEnter={handleModelPanelEnter}
              onMouseLeave={handleModelPanelLeave}
            >
            <ul className="composer-model-picker-models-list">
              <li className="composer-model-picker-models-title">
                {visibleSecondaryProvider ? `${visibleSecondaryProvider.label} · 模型` : "模型"}
              </li>
              {modelGroups
                .find((group) => group.providerId === visibleSecondaryProviderId)
                ?.models.map((model) => (
                  <li key={model.id}>
                    <button
                      type="button"
                      className={`composer-model-picker-model ${selectedProviderId === visibleSecondaryProviderId && selectedModelId === model.id ? "is-selected" : ""}`}
                      onClick={() => {
                        if (visibleSecondaryProviderId) {
                          onSelectModel(visibleSecondaryProviderId, model.id);
                        }
                        setIsOpen(false);
                        setActiveProviderId(null);
                        setHoveredProviderId(null);
                        setModelsPanelAnchor(null);
                      }}
                      role="option"
                      aria-selected={selectedProviderId === visibleSecondaryProviderId && selectedModelId === model.id}
                    >
                      <span className="composer-model-picker-model-label">
                        {model.supportsMultimodalInput ? (
                          <span className="composer-model-picker-multimodal" title="支持多模态输入" aria-label="支持多模态输入">
                            <IconImage />
                          </span>
                        ) : null}
                        <span>{model.label}</span>
                      </span>
                      {selectedProviderId === visibleSecondaryProviderId && selectedModelId === model.id ? (
                        <span className="composer-model-picker-check" aria-hidden="true">✓</span>
                      ) : null}
                    </button>
                  </li>
                ))}
            </ul>
            </FloatingSideMenu>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

