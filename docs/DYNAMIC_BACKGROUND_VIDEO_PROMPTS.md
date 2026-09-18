# 动态背景视频生成提示词（CodeXH 实时状态氛围层）

本文件提供一套**可直接复制使用**的视频生成提示词，用于替换 CodeXH「设置 → 外观 → 动态背景」所用的 7 段状态视频，并记录替换时不可违反的渲染约束。

---

## 1. 这套视频在哪里生效（已核对代码）

| 项目 | 事实 |
| --- | --- |
| 模式开关 | `ChatBackgroundMode = "none" \| "image" \| "dynamic"`（`src/renderer/chat-background.ts`），"dynamic" 即动态背景 |
| 渲染组件 | `apps/desktop/src/renderer/workspace/realtime-character-layer.tsx` |
| 装配位置 | `apps/desktop/src/renderer/App.tsx` 的 `RealtimeCharacterLayer`，`onTerminalVideoEnd` 回调 `realtimeEnhancement.returnToIdle(...)` |
| 素材目录 | `apps/desktop/src/renderer/assets/`，通过 `import ... from "../assets/realtime-state-*.mp4"` 静态打包 |
| 预览 | `settings/pages/application/appearance-page.tsx` 复用 `realtime-state-idle.mp4` 作为动态背景预览 |

### 1.1 渲染层 CSS 约束（`src/renderer/styles.css`）

```css
.realtime-human-video {
  object-fit: cover;
  object-position: 100% 50%;
  opacity: 0.78;
  filter: saturate(0.92) contrast(0.98) brightness(0.86);
  mix-blend-mode: screen;
}
.realtime-human-video-stack {
  mask-image: linear-gradient(90deg, transparent 0%, rgba(0, 0, 0, 0.82) 20%, #000 42%);
}
```

由此得到 5 条对素材的硬要求：

1. **必须暗场**：`mix-blend-mode: screen` 下黑色等于透明，越黑越"隐形"；亮像素会被直接叠加上去，纯白区域会压过正文。
2. **主体靠右**：`object-position: 100% 50%` + 右侧遮罩，画面左侧 0–42% 会被渐隐，趣味点放在画面右侧 1/3–1/2。
3. **镜头必须静止**：任何推拉摇移在 10 秒循环里都会被放大成"漂移"。
4. **高光面积要小**：界面已把亮度压到 0.86、饱和度压到 0.92，多余的高光只会造成阅读干扰。
5. **不要依赖透明通道**：走 screen 混合，纯黑底即可，无需 alpha。

### 1.2 播放语义（决定了每段的时长与收尾）

| 文件 | 时长要求 | 播放行为 |
| --- | --- | --- |
| `realtime-state-idle.mp4` | 10s | 播完 `currentTime = 0` 重播 → **需无缝循环** |
| `realtime-state-generating.mp4` | 5s | 同上，**需无缝循环** |
| `realtime-state-thinking.mp4` | 5s | 与 executing 交替播放（`thinking → executing → thinking …`），**两者需视觉同源** |
| `realtime-state-executing.mp4` | 10s | 同上，交替的另一半 |
| `realtime-state-completed.mp4` | 5s | 播完触发 `onTerminalVideoEnd` → 回到 idle，**结尾须衰减至近黑** |
| `realtime-state-interrupted.mp4` | 5s | 同上 |
| `realtime-state-failed.mp4` | 5s | 同上 |

> 组件对每段视频使用 `loop={false}` + 双槽 680ms 交叉淡入，因此"循环感"由素材本身负责，不要指望播放器。

---

## 2. 现有素材实测规格（Windows Shell 属性实测，非估算）

| 文件 | 时长 | 分辨率 | 帧率 | 体积 |
| --- | --- | --- | --- | --- |
| `realtime-state-idle.mp4` | 10s | 1940×1064 | 24 fps | 4.46 MB |
| `realtime-state-executing.mp4` | 10s | 1940×1064 | 24 fps | 4.73 MB |
| `realtime-state-thinking.mp4` | 5s | 1940×1064 | 24 fps | 1.42 MB |
| `realtime-state-generating.mp4` | 5s | 1940×1064 | 24 fps | 1.67 MB |
| `realtime-state-completed.mp4` | 5s | 1940×1064 | 24 fps | 1.67 MB |
| `realtime-state-interrupted.mp4` | 5s | 1940×1064 | 24 fps | 1.07 MB |
| `realtime-state-failed.mp4` | 5s | 1940×1064 | 24 fps | 1.12 MB |
| `objective-live-speaking-with-audio.mp4` | 6s | 736×400 | 24 fps | 0.33 MB |

说明：这 7 段均带约 130 kbps 音轨，但 `<video>` 上是 `muted`，音轨属于纯体积浪费，新素材建议**直接不带音轨**。`objective-live-speaking-with-audio.mp4` 未被 `realtime-character-layer.tsx` 引用，不属于动态背景这一套。

### 2.1 新素材交付规格（推荐）

- 分辨率：1940×1064（与现有完全一致）或 1920×1080，**宽高比 16:9**
- 帧率：24 fps；编码 H.264 / MP4（H.264 + AAC 是项目已知支持矩阵，`src/main/app.ts` 有 `video/mp4` 映射）
- 音轨：无
- 时长：严格按 §1.2 表格
- 单文件体积建议 ≤ 2.5 MB（现有 idle 已达 4.5 MB，可借机瘦身）
- 文件名必须**完全一致**，放回 `apps/desktop/src/renderer/assets/`

---

## 3. 通用风格基底（七段共用，保证观感同源）

所有提示词都必须包含这 5 组锚点：抽象主体 + 静止镜头 + 匀速无方向性运动 + 极暗低对比光照 + 无文字无人脸。风格统一描述为：

> dark-field abstract volumetric light field, deep teal / indigo base with a single warm accent, smooth gradients, soft focus, understated background plate, subject weight on the right half of the frame

---

## 4. 七段提示词（可直接复制）

### 4.1 idle — 待机 · 深青蓝呼吸（10s，无缝循环）

```text
Subtle abstract ambient loop for a dark UI background plate. Slow-drifting volumetric haze and fine dust particles in deep teal and indigo, with a faint cool cyan glow drifting slowly across the right half of the frame. Vertical haze columns and soft bokeh orbs move at a very slow, even pace. Subject confined to the right third of the frame, left side left almost empty and dark. Locked-off static camera, no pan, no zoom, no dolly, no parallax, no camera shake. Continuous even-paced motion that returns to its starting arrangement by the final frame, so the last frame matches the first frame. Deep black background, very low contrast, dim exposure, no bright specular highlights, no lens flare, no bloom, no flashing lights, constant brightness. Smooth gradients, soft focus, minimal grain, background plate, calm and meditative. No text, no letters, no numbers, no watermark, no logo, no UI, no faces, no hands, no people, no cuts, no scene change, no flicker. Seamless loop, first frame identical to last frame.
```

要点：低强度、无方向性，`#aeb8c8` 中性冷灰调；粒子漂移一周期后必须回到初始分布。

### 4.2 thinking — 思考 · 暖琥珀内旋（5s，参与交替）

```text
Subtle abstract ambient loop for a dark UI background plate. Soft amber and warm peach light filaments slowly spiralling inward around an implied centre in the right half of the frame, like slow-gathering luminous threads. Subject confined to the right third of the frame, left side nearly empty black. Locked-off static camera, no pan, no zoom, no dolly, no parallax, no camera shake. Slow even-paced inward drift, no sudden acceleration, no cuts. Deep black background, very low contrast, dim exposure, no bright specular highlights, no lens flare, no bloom, no flashing lights, constant brightness. Smooth gradients, soft focus, minimal grain, understated background plate. No text, no letters, no numbers, no watermark, no logo, no UI, no faces, no hands, no people, no cuts, no scene change, no flicker. End state visually close to the start so it can alternate with the working clip.
```

要点：对应应用强调色 `#ffb08f`（intensity 0.66）。与 executing 交替播放，**起点/终点都不要有强事件**，否则交替时会看出接缝。

### 4.3 generating — 生成输出 · 冷青流光外溢（5s，无缝循环）

```text
Subtle abstract ambient loop for a dark UI background plate. Fine luminous ribbons of cool cyan and pale violet slowly streaming outward and downward across the right half of the frame, like light drawn over dark water, with a soft warm amber tint at the edges. Subject confined to the right third of the frame, left side almost empty black. Locked-off static camera, no pan, no zoom, no dolly, no parallax, no camera shake. Continuous even-paced streaming motion, no stutter, no burst, the stream returns to its starting arrangement by the final frame. Deep black background, very low contrast, dim exposure, no bright specular highlights, no lens flare, no bloom, no flashing lights, constant brightness. Smooth gradients, soft focus, minimal grain, understated background plate. No text, no letters, no numbers, no watermark, no logo, no UI, no faces, no hands, no people, no cuts, no scene change, no flicker. Seamless loop, first frame identical to last frame.
```

要点：语义是"正在输出文字"，但**绝不能真的出现文字/字形**，用丝带流光暗示即可。

### 4.4 executing — 执行工具 · 琥珀网格能量（10s，参与交替）

```text
Subtle abstract ambient loop for a dark UI background plate. A faint amber and gold energy lattice quietly pulses along thin geometric grid lines in the right half of the frame, with small travelling light sparks moving along the lines at a steady cadence. Subject confined to the right third of the frame, left side nearly empty black. Locked-off static camera, no pan, no zoom, no dolly, no parallax, no camera shake. Rhythmic but gentle pulse, even the pacing, slow enough to stay calm, no strobe, no flashing. Deep black background, very low contrast, dim exposure, no bright specular highlights, no lens flare, no bloom, no flashing lights, constant average brightness. Smooth gradients, soft focus, minimal grain, understated background plate. No text, no letters, no numbers, no watermark, no logo, no UI, no faces, no hands, no people, no cuts, no scene change, no flicker. End state visually close to the start so it can alternate with the thinking clip.
```

要点：对应 `#ffcb7a`（intensity 0.78，`pulse: true`）。帧长 10s，节奏可以比 thinking 稍活跃，但平均亮度必须恒定，避免交替时整屏忽明忽暗。

### 4.5 completed — 完成 · 薄荷绿收束（5s，结尾衰减）

```text
Subtle abstract ambient closing shot for a dark UI background plate. A soft mint-green and pale jade glow gently blooms once in the right half of the frame and then settles, with a few slow-drifting light motes easing to a stop. Subject confined to the right third of the frame, left side nearly empty black. Locked-off static camera, no pan, no zoom, no dolly, no parallax, no camera shake. One calm outward bloom in the first two seconds, then progressively slower, quieter motion, ending nearly still. Deep black background, very low contrast, dim exposure, no bright specular highlights, no lens flare, no bloom, no flashing lights, brightness decays smoothly to dark by the last frame. Smooth gradients, soft focus, minimal grain, understated background plate, quietly satisfying. No text, no letters, no numbers, no trophy, no checkmark, no watermark, no logo, no UI, no faces, no hands, no people, no cuts, no scene change, no flicker.
```

要点：对应 `#9be7b1`。**末尾 0.5–0.8 秒要衰减到近黑**，因为播完会立刻交叉淡回 idle。

### 4.6 interrupted — 中断 · 灰蓝停驻（5s，结尾衰减）

```text
Subtle abstract ambient closing shot for a dark UI background plate. A neutral steel-blue light current in the right half of the frame smoothly decelerates and gently dissipates into still haze, with fine particles losing momentum and fading out. Subject confined to the right third of the frame, left side nearly empty black. Locked-off static camera, no pan, no zoom, no dolly, no parallax, no camera shake. Motion only ever slows down, never accelerates, no snap, no hard stop, no glitch, no glitchy distortion. Deep black background, very low contrast, dim exposure, no bright specular highlights, no lens flare, no bloom, no flashing lights, brightness fades smoothly to dark by the last frame. Smooth gradients, soft focus, minimal grain, understated background plate, neutral and quiet. No text, no letters, no numbers, no warning icon, no watermark, no logo, no UI, no faces, no hands, no people, no cuts, no scene change, no flicker.
```

要点：对应 `#aeb8c8`、intensity 仅 0.18，是强度最低的一段。**不要做成"报错"**，情绪应是"安静停下"。

### 4.7 failed — 失败 · 珊瑚红警示（5s，结尾衰减）

```text
Subtle abstract ambient closing shot for a dark UI background plate. Faint coral-red and ember-orange light veins in the right half of the frame pulse twice in a slow warning rhythm, then dim down and fade into dark haze. Subject confined to the right third of the frame, left side nearly empty black. Locked-off static camera, no pan, no zoom, no dolly, no parallax, no camera shake. Two slow deliberate pulses at low brightness, no strobe, no flashing, no violent motion, no explosion, no fire. Deep black background, very low contrast, dim exposure, no bright specular highlights, no lens flare, no bloom, no flashing lights, brightness decays smoothly to dark by the last frame. Smooth gradients, soft focus, minimal grain, understated background plate. No text, no letters, no numbers, no warning triangle, no exclamation mark, no watermark, no logo, no UI, no faces, no hands, no people, no cuts, no scene change, no flicker.
```

要点：对应 `#ff9e8a`（intensity 0.92，是七段中最强的）。但"强"体现在脉冲次数与色相，不是亮度——高光面积仍要小，否则错误提示会盖住正文。

### 4.8 中文版提示词（与 4.1–4.7 一一等价，可直接复制）

中文提示词保留了全部硬约束（纯黑背景 / 固定镜头 / 右侧主体 / 首尾一致 / 亮度恒定 / 无文字无人脸），只是在描述语上做了中文工程化表达。**七段只能改「主体」与「光照」两句，其余句子逐字保持一致**，否则 thinking 与 executing 交替播放时会看出风格断层。

#### 4.8.0 通用中文骨架

```text
深色界面背景板用的极简抽象氛围循环镜头。【主体】。画幅 16:9，主体集中在画面右侧三分之一，左侧保持近乎空旷的纯黑。镜头完全固定，不推、不摇、不拉、不移动，无视差，无机身抖动。运动持续、匀速、无方向性，最后一帧回到第一帧的初始排列，首尾画面一致。纯黑背景，极低对比度，曝光偏暗，无高亮镜面反光，无镜头光晕，无泛光，无频闪，无亮度突变，整体亮度恒定。渐变柔和，焦点偏软，颗粒极轻，克制的背景板质感。【光照】。不要文字、不要字母、不要数字、不要水印、不要标志、不要界面元素、不要人脸、不要手、不要人物、不要镜头切换、不要场景跳变、不要闪烁。
```

#### 4.8.1 idle — 待机 · 深青蓝呼吸（10s，无缝循环）

```text
深色界面背景板用的极简抽象氛围循环镜头。深青与靛蓝色的体积雾缓慢漂移，细小尘埃颗粒悬浮其中，画面右半幅有一缕淡淡的冷青色微光缓缓掠过。竖直的雾柱与柔和的焦外光斑以极慢、均匀的节奏移动。画幅 16:9，主体集中在画面右侧三分之一，左侧保持近乎空旷的纯黑。镜头完全固定，不推、不摇、不拉、不移动，无视差，无机身抖动。运动持续、匀速、无方向性，最后一帧回到第一帧的初始排列，首尾画面一致。纯黑背景，极低对比度，曝光偏暗，无高亮镜面反光，无镜头光晕，无泛光，无频闪，无亮度突变，整体亮度恒定。渐变柔和，焦点偏软，颗粒极轻，克制的背景板质感，平静而有冥想感。不要文字、不要字母、不要数字、不要水印、不要标志、不要界面元素、不要人脸、不要手、不要人物、不要镜头切换、不要场景跳变、不要闪烁。无缝循环，首帧与末帧完全一致。
```

要点：色相偏中性冷灰调、强度要最低；粒子漂移一个周期后必须回到初始分布。

#### 4.8.2 thinking — 思考 · 暖琥珀内旋（5s，参与交替）

```text
深色界面背景板用的极简抽象氛围循环镜头。暖琥珀与浅桃色的纤细光丝围绕画面右半幅一个隐含的中心缓慢向内旋绕，像缓缓聚拢的发光细线。画幅 16:9，主体集中在画面右侧三分之一，左侧保持近乎空旷的纯黑。镜头完全固定，不推、不摇、不拉、不移动，无视差，无机身抖动。缓慢匀速地向内漂移，没有突然加速，没有切换。纯黑背景，极低对比度，曝光偏暗，无高亮镜面反光，无镜头光晕，无泛光，无频闪，无亮度突变，整体亮度恒定。渐变柔和，焦点偏软，颗粒极轻，克制的背景板质感。不要文字、不要字母、不要数字、不要水印、不要标志、不要界面元素、不要人脸、不要手、不要人物、不要镜头切换、不要场景跳变、不要闪烁。结束画面与起始画面视觉接近，以便与执行段落交替播放。
```

要点：对应强调色 `#ffb08f`。**起点与终点都不能有强事件**，否则与 executing 交替时会露接缝。

#### 4.8.3 generating — 生成输出 · 冷青流光外溢（5s，无缝循环）

```text
深色界面背景板用的极简抽象氛围循环镜头。冷青色与淡紫色的细腻光带在画面右半幅缓慢向外、向下流动，像黑暗水面上被划过的光痕，边缘带一点柔和的暖琥珀色。画幅 16:9，主体集中在画面右侧三分之一，左侧保持近乎空旷的纯黑。镜头完全固定，不推、不摇、不拉、不移动，无视差，无机身抖动。持续匀速的流动感，不卡顿、不爆发，流动在最后一帧回到初始排列。纯黑背景，极低对比度，曝光偏暗，无高亮镜面反光，无镜头光晕，无泛光，无频闪，无亮度突变，整体亮度恒定。渐变柔和，焦点偏软，颗粒极轻，克制的背景板质感。不要文字、不要字母、不要数字、不要水印、不要标志、不要界面元素、不要人脸、不要手、不要人物、不要镜头切换、不要场景跳变、不要闪烁。无缝循环，首帧与末帧完全一致。
```

要点：语义是"正在输出文字"，但**绝不能真的出现文字或字形**，用丝带流光暗示即可。

#### 4.8.4 executing — 执行工具 · 琥珀网格能量（10s，参与交替）

```text
深色界面背景板用的极简抽象氛围循环镜头。淡琥珀与金色的能量网格沿着画面右半幅细密的几何网格线安静地搏动，细小的光点沿着网格线以稳定节奏移动。画幅 16:9，主体集中在画面右侧三分之一，左侧保持近乎空旷的纯黑。镜头完全固定，不推、不摇、不拉、不移动，无视差，无机身抖动。有节奏但轻柔的脉动，节奏均匀，缓慢到保持平静，无频闪、无爆闪。纯黑背景，极低对比度，曝光偏暗，无高亮镜面反光，无镜头光晕，无泛光，无频闪，无亮度突变，平均亮度恒定。渐变柔和，焦点偏软，颗粒极轻，克制的背景板质感。不要文字、不要字母、不要数字、不要水印、不要标志、不要界面元素、不要人脸、不要手、不要人物、不要镜头切换、不要场景跳变、不要闪烁。结束画面与起始画面视觉接近，以便与思考段落交替播放。
```

要点：对应 `#ffcb7a`。节奏可比 thinking 稍活跃，但**平均亮度必须恒定**，避免交替时整屏忽明忽暗。

#### 4.8.5 completed — 完成 · 薄荷绿收束（5s，结尾衰减）

```text
深色界面背景板用的极简抽象氛围收尾镜头。柔和的薄荷绿与淡玉色微光在画面右半幅轻轻泛开一次，随后慢慢沉静下来，几粒缓慢漂浮的光尘逐渐停下。画幅 16:9，主体集中在画面右侧三分之一，左侧保持近乎空旷的纯黑。镜头完全固定，不推、不摇、不拉、不移动，无视差，无机身抖动。前两秒完成一次平静的向外泛光，之后运动逐渐变慢、变轻，结尾近乎静止。纯黑背景，极低对比度，曝光偏暗，无高亮镜面反光，无镜头光晕，无泛光，无频闪，无亮度突变，亮度在最后一帧平滑衰减至暗。渐变柔和，焦点偏软，颗粒极轻，克制的背景板质感，安静的满足感。不要文字、不要字母、不要数字、不要奖杯、不要对勾、不要水印、不要标志、不要界面元素、不要人脸、不要手、不要人物、不要镜头切换、不要场景跳变、不要闪烁。
```

要点：对应 `#9be7b1`。**末尾 0.5–0.8 秒要衰减到近黑**，因为播完会立刻交叉淡回 idle。

#### 4.8.6 interrupted — 中断 · 灰蓝停驻（5s，结尾衰减）

```text
深色界面背景板用的极简抽象氛围收尾镜头。中性钢蓝色的光流在画面右半幅平缓减速，轻轻消散成静止的薄雾，细微颗粒逐渐失去动量并淡出。画幅 16:9，主体集中在画面右侧三分之一，左侧保持近乎空旷的纯黑。镜头完全固定，不推、不摇、不拉、不移动，无视差，无机身抖动。运动只会变慢，从不加速，没有急停，没有硬切，没有故障感扭曲。纯黑背景，极低对比度，曝光偏暗，无高亮镜面反光，无镜头光晕，无泛光，无频闪，无亮度突变，亮度在最后一帧平滑淡至暗。渐变柔和，焦点偏软，颗粒极轻，克制的背景板质感，中性而安静。不要文字、不要字母、不要数字、不要警告图标、不要水印、不要标志、不要界面元素、不要人脸、不要手、不要人物、不要镜头切换、不要场景跳变、不要闪烁。
```

要点：对应 `#aeb8c8`、强度最低的一段。**不要做成"报错"**，情绪应是"安静地停下"。

#### 4.8.7 failed — 失败 · 珊瑚红警示（5s，结尾衰减）

```text
深色界面背景板用的极简抽象氛围收尾镜头。淡淡的珊瑚红与余烬橙色光脉在画面右半幅以缓慢的警示节奏搏动两次，随后逐渐变暗并淡入暗雾。画幅 16:9，主体集中在画面右侧三分之一，左侧保持近乎空旷的纯黑。镜头完全固定，不推、不摇、不拉、不移动，无视差，无机身抖动。两次缓慢克制的脉冲，亮度偏低，无爆闪、无频闪、无剧烈运动、无爆炸、无火焰。纯黑背景，极低对比度，曝光偏暗，无高亮镜面反光，无镜头光晕，无泛光，无频闪，无亮度突变，亮度在最后一帧平滑衰减至暗。渐变柔和，焦点偏软，颗粒极轻，克制的背景板质感。不要文字、不要字母、不要数字、不要警告三角、不要感叹号、不要水印、不要标志、不要界面元素、不要人脸、不要手、不要人物、不要镜头切换、不要场景跳变、不要闪烁。
```

要点：对应 `#ff9e8a`（七段中最强）。"强"体现在脉冲次数与色相，不是亮度——高光面积仍要小，否则错误提示会盖住正文。

---

## 5. 统一负面提示词

模型支持独立 `negative_prompt` 字段时使用（可灵 `kling-v3` 系支持，`kling-v3-turbo` 不支持，需把负向描述并入主提示词）：

```text
text, letters, numbers, subtitles, watermark, logo, signature, UI elements, buttons, human faces, hands, people, creatures, camera shake, pan, zoom, dolly, parallax, jump cut, scene change, flicker, strobing, flashing lights, sudden brightness change, bright white background, high contrast, lens flare, heavy grain, glitch, explosion, fire
```

中文版（与上面英文清单等价，用于只接受中文提示词的模型）：

```text
文字、字母、数字、字幕、水印、标志、签名、界面元素、按钮、人脸、手、人物、生物、镜头抖动、摇镜、推拉镜头、移动镜头、视差、跳切、场景切换、闪烁、频闪、爆闪、亮度突变、纯白背景、高对比度、镜头光晕、重颗粒、故障感、爆炸、火焰
```

若模型没有独立的 `negative_prompt` 字段，不必另写负向词——§4.8 的中文提示词结尾已经把"不要文字、不要字母……不要闪烁"整串并入主提示词，直接复用即可。

失败模式 → 约束词对照：

| 常见失败 | 对应约束词 |
| --- | --- |
| 出现文字/水印/假界面 | `no text, no letters, no numbers, no watermark, no logo, no UI` |
| 人脸/手部畸变 | `no people, no faces, no hands, no creatures` |
| 镜头漂移 | `locked-off static camera, no pan, no zoom, no dolly, no parallax, no camera shake` |
| 亮度突变/频闪 | `constant brightness, no flicker, no strobing, no flashing lights` |
| 硬切换景 | `single continuous shot, no cuts, no scene change` |
| 抢文字阅读 | `deep black background, very low contrast, dim exposure, no bloom, no lens flare` |

---

## 6. 无缝循环与状态切换的落地方法

1. **首尾帧法（最稳）**：先生成一张静帧，再用"图生视频-基于首尾帧"把首帧与尾帧设为同一张图。可灵官方文档明确支持 `first_frame` 与 `first_frame + last_frame` 两种图生视频模式。
2. **乒乓播放（无需模型支持）**：后期把 idle / generating 做成"正放 + 倒放"拼接，天然无缝，但运动方向会反转，只适合无方向性的雾与粒子。
3. **后期交叉淡化**：首尾各取 0.5–1s 做 dissolve，会牺牲一点时长。
4. **terminal 三段（completed / interrupted / failed）不要做循环**：它们的语义是"播完就切回 idle"，只需保证结尾衰减到近黑。
5. **thinking ↔ executing 交替**：两段的起始与结束状态都应该是"低能量、无强事件"，否则交替播放时会看到明显接缝。

> 已知限制：可灵文档中未见 `loop`、`fps` 参数（时长 3–15 秒整数、宽高比 16:9 / 9:16 / 1:1、`mode` 为 `std`/`pro`/`4k`）；Runway 示例字段为 `promptText` / `ratio` / `duration`，未见 negative prompt。Sora、Veo、Luma、Seedance、Pika 的循环与首尾帧能力本轮未取得一手官方说明，请勿当作已知能力写入代码或配置。

---

## 7. 生成后校验清单

1. 文件名与现有 7 个完全一致，放回 `apps/desktop/src/renderer/assets/`。
2. 无音轨；分辨率 16:9；24 fps；单文件 ≤ 2.5 MB。
3. 亮度检查：把视频叠在纯 `#0b0d12` 上，用 screen 混合看一遍，确认没有整屏发白。
4. 循环检查：至少在播放器里连播 3 遍，确认首尾无跳变、无闪帧。
5. 交替检查：thinking 与 executing 连续交替 5 次，确认没有明显亮度台阶。
6. 文字可读性检查：在素材最亮处叠加一段正文，确认仍能看清。
7. 两个模式都过一遍：设置 → 外观 →「动态背景」预览 + 实际对话流（thinking → executing → generating → completed/failed/interrupted）。
