# Graph Report - workagent  (2026-09-04)

## Corpus Check
- 243 files · ~361,308 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3954 nodes · 9268 edges · 169 communities (131 shown, 28 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 450 edges (avg confidence: 0.82)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- MCP 仓库检查与代理协议
- Agent 运行时与恢复机制
- App 主界面与 GPA 交互
- 桌面后端服务 (DesktopBackend)
- 主题与消息浏览器 UI
- 会话流式草稿与工具调用
- 数据库服务与运行记录
- GPA 计划文件管理
- Markdown 渲染与图标
- 浏览器标签与用量统计
- 应用背景管理
- 欢迎页与编辑器组件
- 实时增强与语音能力
- 浏览器页面清洗
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 56
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 70
- Community 71
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 83
- Community 84
- Community 85
- Community 86
- Community 87
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 94
- Community 95
- Community 96
- Community 97
- Community 98
- Community 99
- Community 100
- Community 101
- Community 102
- Community 103
- Community 104
- Community 105
- Community 106
- Community 107
- Community 108
- Community 109
- Community 110
- Community 111
- Community 112
- Community 113
- Community 114
- Community 115
- Community 116
- Community 117
- Community 118
- Community 119
- Community 120
- Community 121
- Community 122
- Community 123
- Community 124
- Community 125
- Community 126
- Community 127
- Community 128
- Community 129
- Community 130
- Community 131
- Community 132
- Community 133
- Community 134
- Community 135
- Community 136
- Community 137
- Community 138
- Community 139
- Community 140
- Community 141
- Community 142
- Community 143
- Community 144
- Community 145
- Community 146
- Community 147
- Community 150
- Community 151
- Community 152
- Community 153
- Community 154
- Community 155
- Community 156
- Community 157
- Community 158
- Community 159
- Community 160

## God Nodes (most connected - your core abstractions)
1. `DesktopBackend` - 249 edges
2. `App()` - 248 edges
3. `registerIpc()` - 141 edges
4. `DatabaseService` - 133 edges
5. `RuntimeServices` - 79 edges
6. `ThreadRecord` - 59 edges
7. `ThreadSessionRuntime` - 39 edges
8. `nowIso()` - 36 edges
9. `registerBuiltinTools()` - 36 edges
10. `GitActionResult` - 30 edges

## Surprising Connections (you probably didn't know these)
- `CodeXH 应用图标` --conceptually_related_to--> `CodeXH README`  [INFERRED]
  assets/icon.png → README.md
- `IPC HTTP 代理通道` --conceptually_related_to--> `HttpProxyRequestPayload`  [INFERRED]
  .codebuddy/plans/interactive-api-card_3bbe3b85.md → apps/desktop/src/main/http-proxy.ts
- `ThreadSearchResult` --references--> `ThreadRecord`  [EXTRACTED]
  apps/desktop/src/main/storage.ts → packages/shared-types/src/index.ts
- `程序图谱生成任务` --references--> `CodeXH README`  [INFERRED]
  .codexh/outputs/d63d8056-d69d-4a1a-8bc1-b69d02d0aabf/context/turn-f102bb4b-7cf1-48d3-8df3-47991d54f27b.md → README.md
- `CodeXH 使用文档` --conceptually_related_to--> `CodeXH README`  [INFERRED]
  docs/website-user-guide.md → README.md

## Import Cycles
- 2-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/agnes.ts -> packages/provider-adapters/src/index.ts`
- 2-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/deepseek.ts -> packages/provider-adapters/src/index.ts`
- 2-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/gemini.ts -> packages/provider-adapters/src/index.ts`
- 2-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/gpt.ts -> packages/provider-adapters/src/index.ts`
- 2-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/kimi.ts -> packages/provider-adapters/src/index.ts`
- 3-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/agnes.ts -> packages/provider-adapters/src/models/gpt.ts -> packages/provider-adapters/src/index.ts`
- 3-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/deepseek.ts -> packages/provider-adapters/src/models/gpt.ts -> packages/provider-adapters/src/index.ts`
- 3-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/gemini.ts -> packages/provider-adapters/src/models/gpt.ts -> packages/provider-adapters/src/index.ts`
- 3-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/glm.ts -> packages/provider-adapters/src/models/gpt.ts -> packages/provider-adapters/src/index.ts`
- 3-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/grok.ts -> packages/provider-adapters/src/models/gpt.ts -> packages/provider-adapters/src/index.ts`
- 3-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/hunyuan.ts -> packages/provider-adapters/src/models/gpt.ts -> packages/provider-adapters/src/index.ts`
- 3-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/index.ts -> packages/provider-adapters/src/models/agnes.ts -> packages/provider-adapters/src/index.ts`
- 3-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/index.ts -> packages/provider-adapters/src/models/deepseek.ts -> packages/provider-adapters/src/index.ts`
- 3-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/index.ts -> packages/provider-adapters/src/models/gemini.ts -> packages/provider-adapters/src/index.ts`
- 3-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/index.ts -> packages/provider-adapters/src/models/gpt.ts -> packages/provider-adapters/src/index.ts`
- 3-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/index.ts -> packages/provider-adapters/src/models/kimi.ts -> packages/provider-adapters/src/index.ts`
- 3-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/kimi.ts -> packages/provider-adapters/src/models/gpt.ts -> packages/provider-adapters/src/index.ts`
- 3-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/qwen.ts -> packages/provider-adapters/src/models/gpt.ts -> packages/provider-adapters/src/index.ts`
- 3-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/sensenova.ts -> packages/provider-adapters/src/models/gpt.ts -> packages/provider-adapters/src/index.ts`
- 4-file cycle: `packages/provider-adapters/src/index.ts -> packages/provider-adapters/src/models/index.ts -> packages/provider-adapters/src/models/agnes.ts -> packages/provider-adapters/src/models/gpt.ts -> packages/provider-adapters/src/index.ts`

## Hyperedges (group relationships)
- **随手记知识库工作流（会话驱动）** — codexh_outputs_05384886_turn_480695ed, codexh_outputs_05384886_turn_d9ced5b3, codexh_concept_quick_notes_knowledge_base, apps_desktop_src_renderer_settings_pages_knowledge_knowledge_page [EXTRACTED 1.00]
- **API 卡片功能计划演进** — codebuddy_plans_interactive_api_card_f8259821, codebuddy_plans_interactive_api_card_3bbe3b85, codebuddy_plans_interactive_api_card_3bbe3b85_concept_ipc_http_proxy, codebuddy_plans_interactive_api_card_f8259821_concept_form_controls [INFERRED 0.85]
- **CodeXH 文档与产品说明集群** — readme_codexh, docs_website_product_introduction, docs_website_user_guide, docs_audit_agent_system_prompt [INFERRED 0.85]
- **运行时可靠性演进主题** — docs_modification_log_concept_gpa_completion, docs_modification_log_concept_deepseek_compat, docs_modification_log_concept_watchdog, docs_modification_log_concept_git_authorization [EXTRACTED 1.00]

## Communities (169 total, 28 thin omitted)

### Community 0 - "MCP 仓库检查与代理协议"
Cohesion: 0.02
Nodes (103): applyStructuredRepositoryResult(), assertAccessibleMcpServer(), buildActCompletionRecoveryInstruction(), buildActiveTurnGuidanceInstruction(), buildAgentProtocolContinuationInput(), buildAgentProtocolContinuationInstruction(), buildBlockedToolCallTranscriptResult(), buildBrowserVerificationDirective() (+95 more)

### Community 1 - "Agent 运行时与恢复机制"
Cohesion: 0.01
Nodes (161): ActCompletionValidationResult, advanceManagedWriteRecovery(), AGENT_PROTOCOL_RECOVERY_QUESTION_ID, AGENT_PROTOCOL_RECOVERY_TIMEOUT_MS, AGENT_PROTOCOL_RECOVERY_TOOL_NAME, AGENT_PROTOCOL_RECOVERY_TOOL_SPEC, AgentModelCompatibilityError, AgentProtocolContinuationRequested (+153 more)

### Community 2 - "App 主界面与 GPA 交互"
Cohesion: 0.03
Nodes (106): App(), activateNewThread(), answerPendingPrompt(), appendOptimisticQueuedMessage(), appendOptimisticUserMessage(), applyPluginEnabledLocally(), beginManualTranscriptScroll(), cancelPendingAutoScrollFrame() (+98 more)

### Community 3 - "桌面后端服务 (DesktopBackend)"
Cohesion: 0.04
Nodes (10): buildCodexhMediaUrl(), compactTerminalInput(), DesktopBackend, getFileSize(), normalizeAttachmentMimeType(), resolveProjectFilePath(), broadcastTheme(), createWindow() (+2 more)

### Community 4 - "主题与消息浏览器 UI"
Cohesion: 0.03
Nodes (82): setBackgroundMode(), toggleTheme(), getRuntimeActivityEntryCreatedAt(), MessageBrowserSource, MessageKnowledgeSource, segmentRuntimeActivityAfterMessage(), TerminalSessionState, ChatWelcome() (+74 more)

### Community 5 - "会话流式草稿与工具调用"
Cohesion: 0.04
Nodes (79): isRuntimeActivityBoundaryMessage(), ActiveToolCall, AssistantDraft, AssistantDraftReasoningBuffer, AssistantDraftStreamBuffer, buildContextUsage(), buildConversationTurnSections(), buildTimelineEntries() (+71 more)

### Community 6 - "数据库服务与运行记录"
Cohesion: 0.04
Nodes (9): DatabaseService, hashPath(), nowIso(), resetConversationGpaState(), ArtifactRecord, KnowledgeBaseRecord, KnowledgeImportSource, QuickNoteRecord (+1 more)

### Community 7 - "GPA 计划文件管理"
Cohesion: 0.05
Nodes (26): buildGpaPlanFileResumeDirective(), formatGpaPlanMarkdown(), GPA_PLAN_RELATIVE_PATH, GpaPlanFileDocument, GpaPlanFileStatus, gpaPlanHasIncompleteTasks(), GpaPlanResumePreview, parseGpaPlanMarkdown() (+18 more)

### Community 8 - "Markdown 渲染与图标"
Cohesion: 0.05
Nodes (60): IconCode(), IconFile(), getSelectedMessageContexts(), SelectedMessageContext, normalizeMarkdownImageSource(), renderMarkdownDocument(), ApprovalCard(), areToolActivityGroupsEqual() (+52 more)

### Community 9 - "浏览器标签与用量统计"
Cohesion: 0.03
Nodes (65): Notice, SettingsUsagePage(), SettingsUsagePageProps, ApiFormat, ApprovalDecision, ApprovalMode, ApprovalRequestKind, ApprovalResolutionMode (+57 more)

### Community 10 - "应用背景管理"
Cohesion: 0.04
Nodes (53): APPLICATION_BACKGROUND_MIME_TYPES, ApplicationBackgroundCollectionPayload, ApplicationBackgroundItemMetadata, ApplicationBackgroundItemPayload, ApplicationBackgroundMetadata, areMcpServerConfigsEqual(), buildPromptDefaultAnswers(), compactRuntimeToolResult() (+45 more)

### Community 11 - "欢迎页与编辑器组件"
Cohesion: 0.05
Nodes (48): CHAT_WELCOME_CARDS, PROJECT_WELCOME_CARDS, ComposerAddMenu(), ComposerAddMenuProps, ComposerAddMenuView, MenuSubmenuButtonProps, FloatingSideMenu(), getHistoryItemAffordance() (+40 more)

### Community 12 - "实时增强与语音能力"
Cohesion: 0.06
Nodes (32): Options, useRealtimeEnhancement(), createRealtimeSceneState(), DEFAULT_REACTION, includesAny(), isString(), now(), readThreadStatus() (+24 more)

### Community 13 - "浏览器页面清洗"
Cohesion: 0.07
Nodes (54): BROWSER_PAGE_TEXT_LIMIT, pageForModel(), PageLike, sanitizeBrowserToolJson(), truncatePageText(), aggregateFederatedRows(), buildApplyPatchFailureMessage(), buildCodeSearchCommand() (+46 more)

### Community 14 - "Community 14"
Cohesion: 0.08
Nodes (10): fileSha256(), normalizeBrowserAssertionChecks(), normalizeBrowserViewport(), readPngDimensions(), seedBundledSkills(), isBrowserErrorPageUrl(), resolveBrowserOpenPreferences(), BrowserAssertionCheck (+2 more)

### Community 15 - "Community 15"
Cohesion: 0.07
Nodes (47): CHAT_BACKGROUND_SURFACE_OPTIONS, ChatBackgroundFit, ChatBackgroundMode, ChatBackgroundSettings, ChatBackgroundSurfaceKey, ChatBackgroundSurfaces, clamp(), DEFAULT_CHAT_BACKGROUND_SETTINGS (+39 more)

### Community 16 - "Community 16"
Cohesion: 0.07
Nodes (46): ContextCompactionNotice(), formatNotificationElapsed(), getNotificationStatusLabel(), EMPTY_NOTIFICATION_CENTER_STATE, findActiveNotification(), isFinishedNotification(), NOTIFICATION_HISTORY_LIMIT, NotificationCenterAction (+38 more)

### Community 17 - "Community 17"
Cohesion: 0.06
Nodes (23): ConversationLogWindow, Options, conversationLogWindow, redactRuntimeLogPayload(), redactSecrets(), RuntimeLogLimits, RuntimeLogStats, RuntimeLogWriter (+15 more)

### Community 18 - "Community 18"
Cohesion: 0.07
Nodes (49): applyProviderRequestLimits(), buildCompactedRecentToolContent(), buildCompactedSystemContent(), canonicalizeProviderToolName(), cloneToolSchemaValue(), coalesceStrictWireMessages(), collectToolDescriptionCandidates(), compactInternalContextSummaries() (+41 more)

### Community 19 - "Community 19"
Cohesion: 0.07
Nodes (25): CachedTools, clampCount(), collectMcpResultCandidates(), connectionFingerprint(), createMcpClient(), discover(), extractMcpRepositoryToolResult(), isMcpSessionInvalidError() (+17 more)

### Community 20 - "Community 20"
Cohesion: 0.11
Nodes (37): buildDecisionSystemPrompt(), GeneratedImageResult, agnesCompat, deepseekCompat, geminiCompat, glmCompat, gptCompat, appendGrokCompletionAuditInstruction() (+29 more)

### Community 21 - "Community 21"
Cohesion: 0.08
Nodes (46): annotateDatabaseError(), columnsSql(), containsTokenSequence(), CredentialProvider, DATABASE_CONNECTION_TEST_TIMEOUT_MS, DATABASE_FEDERATED_INPUT_MAX_ROWS, DATABASE_FEDERATED_OUTPUT_MAX_ROWS, DATABASE_MAX_ROWS (+38 more)

### Community 22 - "Community 22"
Cohesion: 0.07
Nodes (47): compactSubagentResultSummary(), ComposerSubmissionStatus(), formatActivityAge(), formatElapsedClock(), formatRuntimeEventOffset(), getRuntimeEntryCreatedAt(), getRuntimeHistoryLabel(), getSubagentActivityLabel() (+39 more)

### Community 23 - "Community 23"
Cohesion: 0.08
Nodes (7): buildSubagentCompletionSummary(), resolveSubagentWatchdogDecision(), RuntimeEvent, SubagentResultEnvelope, SubagentWaitResult, SubagentWatchdogDiagnostic, ThreadRecord

### Community 24 - "Community 24"
Cohesion: 0.10
Nodes (37): diffEntities(), EntityChangeType, formatEntityChanges(), keyOf(), astDiffSources(), AstLanguageId, EXTENSION_LANGUAGE_MAP, isAstSupportedPath() (+29 more)

### Community 25 - "Community 25"
Cohesion: 0.10
Nodes (36): EntityChange, applyLocatedHunk(), countHunkEdits(), additionsOnlyLines(), applyCodexPatch(), applyHunks(), ApplyPatchOptions, ApplyPatchResult (+28 more)

### Community 26 - "Community 26"
Cohesion: 0.07
Nodes (35): ComposerModelGroup, ComposerModelPicker(), ContextUsageControl(), ContextUsageReport(), formatByteCount(), GPT_REASONING_EFFORT_LABELS, ReasoningEffortPicker(), MotionPresenceAction (+27 more)

### Community 27 - "Community 27"
Cohesion: 0.07
Nodes (31): IconClose(), IconKnowledge(), IconPlus(), IconRefresh(), IconSpinner(), IconTerminal(), FetchedModel, FetchedModelRow (+23 more)

### Community 28 - "Community 28"
Cohesion: 0.05
Nodes (39): @anthropic-ai/sdk, cheerio, gray-matter, highlight.js, iconv-lite, jsonrepair, jszip, @modelcontextprotocol/sdk (+31 more)

### Community 29 - "Community 29"
Cohesion: 0.09
Nodes (27): CHINESE_SKILL_DESCRIPTIONS, discoverSkillRoots(), loadSkillsFromRoots(), METADATA_FILE, normalizeSkillDomain(), OpenAiMetadataFile, readOptionalMetadataFile(), readSkillDirectory() (+19 more)

### Community 30 - "Community 30"
Cohesion: 0.15
Nodes (22): BranchRefs, buildPullRequestUrl(), EMPTY_SNAPSHOT, emptyFile(), getSwitchableBranchNames(), GitCommandResult, GitService, normalizeDiffPath() (+14 more)

### Community 31 - "Community 31"
Cohesion: 0.09
Nodes (16): CredentialSafeStorage, McpCredentialStore, McpOAuthService, startCallbackServer(), StoredCredentials, tokensKey(), verifierKey(), McpTestResult (+8 more)

### Community 32 - "Community 32"
Cohesion: 0.13
Nodes (35): backtrackSnapshotMyersDiff(), buildChangedSnapshotLines(), buildFileSnapshotDiff(), buildFileSnapshotDiffPreview(), buildProjectFileTree(), buildProjectFolderManifest(), buildSnapshotLcsDiff(), buildSnapshotMyersDiff() (+27 more)

### Community 33 - "Community 33"
Cohesion: 0.08
Nodes (21): AnthropicProvider, assertNever(), AutoOpenAiProvider, downloadGeneratedVideo(), extractGeneratedImagePayload(), extractGeneratedVideoPayload(), extractVideoErrorMessage(), extractVideoRequestId() (+13 more)

### Community 34 - "Community 34"
Cohesion: 0.09
Nodes (34): consumeAnthropicStream(), consumeResponsesStream(), dropTrailingPartialThinkTag(), extractResponsesReasoning(), extractResponsesReasoningItem(), extractResponsesText(), extractResponsesToolCalls(), extractVisibleStreamText() (+26 more)

### Community 35 - "Community 35"
Cohesion: 0.12
Nodes (25): exists(), extractMcpServerEntries(), hashDirectory(), normalizeEnv(), normalizeHookDeclaration(), normalizeMcpServerConfig(), normalizePluginSource(), normalizeSkillSubdirectory() (+17 more)

### Community 36 - "Community 36"
Cohesion: 0.10
Nodes (32): backend, createTray(), deliveredSystemNotificationKeys, deliverSystemNotification(), __dirname, ensureRendererServerUrl(), __filename, getContentType() (+24 more)

### Community 37 - "Community 37"
Cohesion: 0.13
Nodes (30): addApiCardFavorite(), API_CARD_FAVORITES_STORAGE_KEY, ApiCardFavoriteNotice, ApiCardFavoritesBridge, emitFavoriteNotice(), EMPTY_FAVORITES, filterApiCardFavorites(), getApiCardFavoriteKey() (+22 more)

### Community 38 - "Community 38"
Cohesion: 0.10
Nodes (30): copyChartText(), ECHARTS_CONFIG_MAX_BYTES, ECHARTS_DARK_THEME, ECHARTS_LIGHT_THEME, ECHARTS_THEME_NAMES, EChartsMessageChart(), EChartsReportChart(), copyConfig() (+22 more)

### Community 39 - "Community 39"
Cohesion: 0.07
Nodes (31): AsyncQueue, buildRuntimePrompt(), collectRequestedArtifactEvidence(), extractArtifactPreview(), findChangedRequestedArtifactPaths(), formatRuntimeDate(), hasSubstantiveTestCaseDeliverable(), hasUnitTestReport() (+23 more)

### Community 40 - "Community 40"
Cohesion: 0.09
Nodes (32): API_CARD_CONFIG_MAX_BYTES, API_CARD_FIELD_TYPES, API_CARD_METHODS, API_CARD_RESPONSE_PREVIEW_CHARS, ApiCardAuth, ApiCardField, ApiCardFieldOption, ApiCardFieldType (+24 more)

### Community 41 - "Community 41"
Cohesion: 0.10
Nodes (31): cacheThreadSnapshot(), invalidateSnapshotRequest(), reconcileCachedAndSelectedSnapshot(), reconcileSnapshotWithRuntimeEvents(), refreshSnapshotOnce(), requestClearCurrentChat(), requestDeleteHistoryThread(), restoreCachedThreadSnapshot() (+23 more)

### Community 42 - "Community 42"
Cohesion: 0.10
Nodes (26): ComposerAttachmentChip(), ComposerAttachments(), Props, IconCopy(), ComposerAttachment, CODE_LANGUAGE_ALIASES, consolidateLooseOrderedLists(), highlightMarkdownCode() (+18 more)

### Community 43 - "Community 43"
Cohesion: 0.09
Nodes (25): IconArrowDown(), IconArrowUp(), IconComment(), IconEye(), IconFileChanges(), IconUndo(), BrowserTabWebview(), BrowserWebviewElement (+17 more)

### Community 44 - "Community 44"
Cohesion: 0.13
Nodes (26): useIsApiCardFavorited(), createInitialValues(), formatApiResponseBody(), ApiCardMessage(), ApiCardResult, ApiCardThreadContext, authHelpText(), methodBadgeClass() (+18 more)

### Community 45 - "Community 45"
Cohesion: 0.09
Nodes (26): addComposerAttachment(), addDroppedFiles(), chooseComposerFiles(), formatByteSize(), formatFileChangeAction(), formatStorageBytes(), formatUpdateDownloadSize(), formatUpdatePhase() (+18 more)

### Community 46 - "Community 46"
Cohesion: 0.09
Nodes (28): applyCompletedPlanTasks(), buildGpaRiskClarificationQuestions(), buildGpaSystemDirective(), buildGpaTextClarificationQuestions(), canEnterGpaAct(), canStartGpaStage(), clarificationOptions(), DEFAULT_GPA_STATE (+20 more)

### Community 47 - "Community 47"
Cohesion: 0.11
Nodes (26): attachmentDataUrl(), buildAnthropicContent(), buildAnthropicMessages(), buildGeminiContents(), buildGeminiParts(), buildOpenAiCompatibleMessages(), buildOpenAiContent(), buildResponsesContent() (+18 more)

### Community 48 - "Community 48"
Cohesion: 0.09
Nodes (24): ManagedRemoval, IconCheck(), IconSkills(), IconStop(), IconTrash(), PluginsPage(), Props, Props (+16 more)

### Community 49 - "Community 49"
Cohesion: 0.12
Nodes (25): accessAllows(), buildChatRuntimePrompt(), CHAT_EXECUTE_TOOLS, CHAT_READ_TOOLS, CHAT_WRITE_TOOLS, ChatLocalAccess, ChatRuntimePolicy, containsAttachedLocalContext() (+17 more)

### Community 50 - "Community 50"
Cohesion: 0.17
Nodes (25): normalizeAppConfig(), normalizeMultimodalDefaults(), normalizeMultimodalInputDefaults(), defaultConfig(), ensureHomeLayout(), exists(), loadConfig(), migrateProvider() (+17 more)

### Community 51 - "Community 51"
Cohesion: 0.09
Nodes (26): buildLabSystemPrompt(), describeSkillLabFailure(), extractMarkdownCodeBlocks(), isSkillLabAbortError(), isSkillLabOutputLimitError(), isSkillLabRecoverableError(), McpResourceEntry, McpToolEntry (+18 more)

### Community 52 - "Community 52"
Cohesion: 0.12
Nodes (27): appendRuntimeDecisionStatusAfterTool(), appendRuntimeOutput(), appendRuntimeStatus(), completeRuntimeTool(), upsertRuntimeTool(), trimRuntimeActivityEntries(), compactRuntimeTarget(), getFileWriteTarget() (+19 more)

### Community 53 - "Community 53"
Cohesion: 0.14
Nodes (18): expandKnowledgeSources(), knowledgeExtensionForMimeType(), normalizeKnowledgeImportSources(), normalizeKnowledgeUrl(), resolveKnowledgeImportDisplayName(), decodeXml(), extractDocument(), extractDocumentBuffer() (+10 more)

### Community 54 - "Community 54"
Cohesion: 0.15
Nodes (14): ActiveCommand, buildBackgroundLaunchCommand(), findLocalServerUrl(), inferLocalServerUrl(), isLocalServerCommand(), redactTerminalSecrets(), redirectStaticHtmlLaunch(), shellLabel() (+6 more)

### Community 55 - "Community 55"
Cohesion: 0.11
Nodes (25): buildCompactedTranscriptSummary(), buildExplicitAuthorizationRequirement(), buildStoredTurnContextPrompt(), compactPersistedToolMessageForModel(), compactTranscript(), compactTranscriptForContext(), createContextBudgetPlan(), estimatePersistedMessageTokens() (+17 more)

### Community 56 - "Community 56"
Cohesion: 0.18
Nodes (7): estimateTokenCount(), runSkillDraftTests(), SkillLabService, ModelProfile, ProviderDefinition, RuntimeToolCall, ToolSpecDefinition

### Community 57 - "Community 57"
Cohesion: 0.13
Nodes (22): applyMultimodalInputRecognitionToTranscript(), buildMultimodalInputRecognizeSystemPrompt(), buildMultimodalInputRecognizeTranscript(), buildMultimodalIntentClassifySystemPrompt(), buildMultimodalIntentClassifyTranscript(), describeAttachments(), detectMultimodalIntent(), detectRequestedImageCount() (+14 more)

### Community 58 - "Community 58"
Cohesion: 0.19
Nodes (20): decodeDispositionFileName(), hasAttachmentDisposition(), isTextualResponseMimeType(), looksLikeBinaryData(), MIME_EXTENSIONS, normalizeResponseMimeType(), resolveHttpDownloadFileName(), sanitizeDownloadFileName() (+12 more)

### Community 59 - "Community 59"
Cohesion: 0.10
Nodes (21): CodeXH 应用图标, CodeXH 品牌, graphify 图谱生成技能, 程序图谱生成任务, Repository Inspection MCP Contract, opaque cursor 分页, structuredContent 分页契约, 修改记录 (+13 more)

### Community 60 - "Community 60"
Cohesion: 0.12
Nodes (15): shouldKeepTimelineEntryWhenTurnCollapsed(), SkillNameMap, TimelineEntry, DirectoryReadGroup(), ConversationTurnSection, Props, TimelineEntries, UserInputPromptCard() (+7 more)

### Community 61 - "Community 61"
Cohesion: 0.10
Nodes (21): electron, electron-builder, electron-vite, devDependencies, electron, electron-builder, electron-vite, @types/node (+13 more)

### Community 62 - "Community 62"
Cohesion: 0.12
Nodes (20): appendRecoveryEpisodeStep(), buildBlockedStrategySummary(), buildRecoverySolutionSummary(), calculateErrorSolutionConfidence(), createRecoveryEpisode(), createRecoveryPrerequisiteToolCall(), createRecoveryStrategyFingerprint(), getToolCallRecoveryTargetKey() (+12 more)

### Community 63 - "Community 63"
Cohesion: 0.19
Nodes (12): isSemver(), isVersionGreater(), parseSemver(), quoteForCmd(), readDownloadUrl(), readSha256(), readVersion(), UpdateManifest (+4 more)

### Community 65 - "Community 65"
Cohesion: 0.12
Nodes (5): buildThreadTitleFromFirstMessage(), getChunkLocator(), splitKnowledgeDocument(), KnowledgeBaseSummary, PluginRecord

### Community 66 - "Community 66"
Cohesion: 0.16
Nodes (16): ModelTestResult, Notice, Options, useProviderModelTesting(), checkProviderModel(), getModelProfileKey(), hasProviderTestEndpoint(), hasStoredSecret() (+8 more)

### Community 67 - "Community 67"
Cohesion: 0.19
Nodes (12): Notice, useErrorSolutions(), refresh(), remove(), useExpandedIds(), Notice, useSelfImprovementMemories(), refresh() (+4 more)

### Community 68 - "Community 68"
Cohesion: 0.21
Nodes (17): Notice, Options, useProviderDraftEditor(), addCustomProvider(), removeProvider(), reset(), setProviderAsDefault(), updateProviderDraft() (+9 more)

### Community 69 - "Community 69"
Cohesion: 0.20
Nodes (16): FileSnapshot, getFileLeafName(), ComposerTaskChanges(), ConversationTurnRail(), FileChangeSummary(), getConversationTurnMarkerWidth(), getConversationTurnPreview(), getFileChangeLineCounts() (+8 more)

### Community 70 - "Community 70"
Cohesion: 0.14
Nodes (16): arc(), blue, blueSoft, chunk(), crc32(), createPng(), dark, icoHeader (+8 more)

### Community 72 - "Community 72"
Cohesion: 0.17
Nodes (14): IconChart(), IconChecklist(), IconGear(), IconGlobe(), IconSinglePanel(), Props, SettingsDialog(), SettingsDialogProps (+6 more)

### Community 73 - "Community 73"
Cohesion: 0.20
Nodes (16): getMcpJsonEntries(), getProviderSubtitle(), getProviderTransportLabel(), McpJsonInput, normalizeMcpJsonApprovalMode(), normalizeMcpJsonAuth(), normalizeMcpJsonEnvironment(), normalizeMcpJsonToolPolicies() (+8 more)

### Community 74 - "Community 74"
Cohesion: 0.12
Nodes (16): build, afterPack, appId, asar, directories, electronDist, extraResources, files (+8 more)

### Community 75 - "Community 75"
Cohesion: 0.14
Nodes (12): articleFor(), canonicalizeToolName(), fullyQualifiedName(), isChildReadOnlyForbiddenTool(), isRecord(), jsonValueType(), matchesJsonSchemaType(), normalizeLegacyToolArguments() (+4 more)

### Community 76 - "Community 76"
Cohesion: 0.12
Nodes (16): compilerOptions, allowJs, allowSyntheticDefaultImports, baseUrl, esModuleInterop, forceConsistentCasingInFileNames, ignoreDeprecations, isolatedModules (+8 more)

### Community 77 - "Community 77"
Cohesion: 0.17
Nodes (9): buildErrorSolutionFtsQuery(), buildErrorSolutionScopeKey(), calculateStoredErrorSolutionConfidence(), extractKnowledgeSearchTerms(), mapErrorSolutionRow(), mapSelfImprovementMemoryRow(), redactStoredMemory(), ErrorSolutionRecord (+1 more)

### Community 78 - "Community 78"
Cohesion: 0.22
Nodes (15): MultimodalKind, Notice, Options, PickerRole, setRoleOnDraft(), useMultimodalSettings(), applyPicker(), clearInputDefault() (+7 more)

### Community 79 - "Community 79"
Cohesion: 0.12
Nodes (9): Notice, QuickNote, QuickNoteDeleteConfirm, QuickNoteListMenu, useQuickNotes(), select(), 随手记知识库（数据库托管）, 随手记刷新按钮需求 (+1 more)

### Community 81 - "Community 81"
Cohesion: 0.12
Nodes (6): Language, Parser, Query, SyntaxNode, Tree, web-tree-sitter

### Community 82 - "Community 82"
Cohesion: 0.13
Nodes (12): buildIterationSummary(), buildLabPrompt(), buildMcpListResourcesSpec(), buildMcpReadResourceSpec(), buildSkillLabRemediationPrompt(), buildSkillLoadSpec(), buildTestSummary(), isPathWithinDirectory() (+4 more)

### Community 83 - "Community 83"
Cohesion: 0.13
Nodes (14): compilerOptions, types, extends, include, electron, electron.vite.config.ts, node, ../../packages/**/*.ts (+6 more)

### Community 84 - "Community 84"
Cohesion: 0.13
Nodes (15): scripts, build, check:runtime, dev, fetch:grammars, generate:icon, package:win, prebuild (+7 more)

### Community 85 - "Community 85"
Cohesion: 0.22
Nodes (13): coalesceKimiMessages(), collectKimiExistingFiles(), extractKimiAddFileContent(), KIMI_EXISTING_FILE_TOOLS, kimiCompat, KimiPatchSection, mergeKimiMessageContent(), normalizeKimiApplyPatchCall() (+5 more)

### Community 86 - "Community 86"
Cohesion: 0.22
Nodes (12): Notice, Options, useDatabaseConnections(), add(), remove(), save(), setEnabled(), updateDraft() (+4 more)

### Community 87 - "Community 87"
Cohesion: 0.22
Nodes (12): getProviderDisplayName(), modelKey(), getModelProviderLabel(), MultimodalPickerDialog(), MultimodalPickerRole, MultimodalPickerRow, Props, RuntimeOverviewPage() (+4 more)

### Community 88 - "Community 88"
Cohesion: 0.21
Nodes (10): live-edit-preview.html 页面, ActivePreview, LiveEditPreviewApp(), PreviewEvent, escapeHtml(), FilePreviewDialog(), FILE_PREVIEW_LANGUAGES, FilePreviewLanguage (+2 more)

### Community 89 - "Community 89"
Cohesion: 0.24
Nodes (12): chooseVerifiedPath(), collectVerifiedPaths(), comparablePathSegments(), FILE_PATH_ARGUMENT_TOOLS, isSafeQwenPathDrift(), normalizePath(), normalizeQwenFileToolDecision(), normalizeQwenPatchPaths() (+4 more)

### Community 90 - "Community 90"
Cohesion: 0.24
Nodes (11): buildChildAgentPrompt(), normalizeAgentSegment(), extractDelegatedFileScopes(), FILE_EXTENSIONS, isExplicitMcpProhibition(), isOverlappingSubagentAssignment(), matchesMcpProhibition(), normalizeDelegationPrompt() (+3 more)

### Community 91 - "Community 91"
Cohesion: 0.23
Nodes (7): mapTurnRunRow(), usageAnalyticsBucket(), addTokenUsage(), createEmptyTokenUsage(), finalizeTokenUsage(), parseTokenUsageJson(), TurnRunRecord

### Community 93 - "Community 93"
Cohesion: 0.29
Nodes (12): buildUserWorkflowPrompt(), compactDescription(), normalizeUserSkillName(), parseUserWorkflowDraft(), readString(), renderUserWorkflowSkill(), retainNewestEntries(), sanitizeWorkflowText() (+4 more)

### Community 94 - "Community 94"
Cohesion: 0.20
Nodes (4): LiveEditPreviewQueue, LiveEditPreviewSession, QueuedLiveEditPreviewSession, Options

### Community 95 - "Community 95"
Cohesion: 0.32
Nodes (11): collectDraftRecords(), isOtherChoice(), parseSkillDryRun(), parseSkillLabClarification(), parseSkillLabIteration(), readStringArray(), readToolString(), extractCompleteJsonValues() (+3 more)

### Community 96 - "Community 96"
Cohesion: 0.17
Nodes (7): SkillLabClarification, SkillLabMode, SkillLabModelOption, SkillLabStatus, useSkillLab(), UseSkillLabOptions, SkillLabProgress

### Community 97 - "Community 97"
Cohesion: 0.17
Nodes (11): description, engines, node, pnpm, license, main, name, packageManager (+3 more)

### Community 99 - "Community 99"
Cohesion: 0.22
Nodes (4): isPathWithinDirectory(), reserveUserSkillDirectory(), resolveThreadModelSelection(), userWorkflowToolCall()

### Community 100 - "Community 100"
Cohesion: 0.22
Nodes (7): browserTabOriginKey(), BrowserTabSession, loadPage(), MAX_BROWSER_TABS_PER_THREAD, PageLoader, PageSnapshot, resolveTarget()

### Community 101 - "Community 101"
Cohesion: 0.24
Nodes (8): Notice, UpdateConfirmDialog, UpdateState, useAppUpdate(), confirm(), download(), proceedDownload(), proceedInstall()

### Community 102 - "Community 102"
Cohesion: 0.22
Nodes (10): Notice, Options, useMcpDraftEditor(), addServer(), closeCreateSheet(), confirmCreate(), removeServer(), updateServerDraft() (+2 more)

### Community 104 - "Community 104"
Cohesion: 0.20
Nodes (3): createSearchSnippet(), fuzzyMatchScore(), mapThreadRow()

### Community 106 - "Community 106"
Cohesion: 0.33
Nodes (9): Options, parseWorkspaceFileKey(), useProjectFilePreview(), closeProjectPreview(), openProjectPreview(), saveProjectPreview(), selectProjectFile(), workspaceFileKey() (+1 more)

### Community 107 - "Community 107"
Cohesion: 0.33
Nodes (9): findSequenceMatches(), HunkLines, inferAnchorLine(), inferSymbolNameHint(), locateHunk(), LocateResult, narrowBySymbols(), parseHunkParts() (+1 more)

### Community 108 - "Community 108"
Cohesion: 0.25
Nodes (7): FetchedModel, Notice, Options, useFetchedProviderModels(), applyFetchedModels(), addModelToProvider(), createModelProfile()

### Community 109 - "Community 109"
Cohesion: 0.28
Nodes (8): Tree-sitter Grammar WASM Assets, CORE_WASM_CANDIDATES, download(), ensureFile(), GRAMMARS, main(), outDir, root

### Community 110 - "Community 110"
Cohesion: 0.31
Nodes (9): applyLegacyMcpResultToRepositoryExploration(), clampRepositoryNumber(), getMcpRepositoryToolResult(), getRepositoryMcpToolKind(), isFocusedRepositoryMcpKind(), isRecordValue(), isRepositoryRootPath(), prepareRepositoryExplorationCall() (+1 more)

### Community 111 - "Community 111"
Cohesion: 0.29
Nodes (4): mapQueuedMessageRow(), api, QueuedMessageRecord, RuntimeThreadSnapshotCursor

### Community 112 - "Community 112"
Cohesion: 0.25
Nodes (3): Notice, KnowledgeChunkRecord, KnowledgeDocumentRecord

### Community 113 - "Community 113"
Cohesion: 0.25
Nodes (7): RendererNotificationNavigationTarget, RendererPendingResumeThread, RendererRuntimeLogPage, RendererSkillLabEvent, RendererSubagentResultEnvelope, UpdateState, Window

### Community 114 - "Community 114"
Cohesion: 0.25
Nodes (8): nsis, allowToChangeInstallationDirectory, deleteAppDataOnUninstall, installerIcon, oneClick, perMachine, runAfterFinish, uninstallerIcon

### Community 115 - "Community 115"
Cohesion: 0.39
Nodes (6): classifyResponsesFallback(), createApiFormatRequestError(), errorField(), isFreshApiFormatCache(), rememberApiFormat(), technicalErrorSummary()

### Community 116 - "Community 116"
Cohesion: 0.32
Nodes (7): isPythonScaffoldingCommand(), isWebFrontendTaskText(), prepareShellCommandForWebFrontend(), prepareShellCommandForWindows(), quotePowerShellArgument(), WEB_FRONTEND_PYTHON_BLOCK_MESSAGE, WINDOWS_CMD_PATTERNS

### Community 117 - "Community 117"
Cohesion: 0.43
Nodes (4): buildApprovalScopeKey(), hasGitMutationAuthorization(), mapRememberedApprovalRow(), RememberedApprovalRecord

### Community 118 - "Community 118"
Cohesion: 0.29
Nodes (7): packages/agent-runtime/src/*, packages/agent-runtime/src/index.ts, packages/plugin-runtime/src/*, packages/plugin-runtime/src/index.ts, paths, @agent-runtime/*, @plugin-runtime/*

### Community 121 - "Community 121"
Cohesion: 0.40
Nodes (5): default(), { execFileSync }, fs, path, wait()

### Community 122 - "Community 122"
Cohesion: 0.33
Nodes (4): archive, output, sevenZip, toolDir

### Community 123 - "Community 123"
Cohesion: 0.60
Nodes (4): getLiveEditWriteTargets(), LiveEditPreviewToolCall, parseArguments(), uniquePaths()

### Community 126 - "Community 126"
Cohesion: 0.40
Nodes (4): ApiCardFavorite, ApiCardConfig, ApiFavoritesPage(), ApiFavoritesPageProps

### Community 127 - "Community 127"
Cohesion: 0.60
Nodes (4): useKnowledgeBases(), deleteBase(), refreshBase(), refreshBases()

### Community 128 - "Community 128"
Cohesion: 0.50
Nodes (4): Notice, useRuntimeLogMaintenance(), confirmClear(), refresh()

### Community 130 - "Community 130"
Cohesion: 0.50
Nodes (4): copyUserMessage(), CopyTextButton(), copy(), copyTextToClipboard()

### Community 131 - "Community 131"
Cohesion: 0.50
Nodes (3): ModelDecisionTimeoutError, waitForAbortOrIdleTimeout(), waitForAbortOrTimeout()

### Community 132 - "Community 132"
Cohesion: 0.50
Nodes (4): DOM, DOM.Iterable, ES2022, lib

### Community 133 - "Community 133"
Cohesion: 0.50
Nodes (3): outputRoot, scopes, sourceRoot

### Community 136 - "Community 136"
Cohesion: 0.67
Nodes (3): 交互式 API 卡片计划（已完成版）, 交互式 API 卡片计划（未完成版）, 预制表单控件库

### Community 137 - "Community 137"
Cohesion: 0.67
Nodes (3): packages/browser-runtime/src/*, packages/browser-runtime/src/index.ts, @browser-runtime/*

### Community 138 - "Community 138"
Cohesion: 0.67
Nodes (3): packages/database-runtime/src/*, packages/database-runtime/src/index.ts, @database-runtime/*

### Community 139 - "Community 139"
Cohesion: 0.67
Nodes (3): packages/knowledge-runtime/src/*, packages/knowledge-runtime/src/index.ts, @knowledge-runtime/*

### Community 140 - "Community 140"
Cohesion: 0.67
Nodes (3): packages/mcp-runtime/src/*, packages/mcp-runtime/src/index.ts, @mcp-runtime/*

### Community 141 - "Community 141"
Cohesion: 0.67
Nodes (3): packages/provider-adapters/src/*, packages/provider-adapters/src/index.ts, @provider-adapters/*

### Community 142 - "Community 142"
Cohesion: 0.67
Nodes (3): packages/shared-types/src/*, packages/shared-types/src/index.ts, @shared-types/*

### Community 143 - "Community 143"
Cohesion: 0.67
Nodes (3): packages/skills-runtime/src/*, packages/skills-runtime/src/index.ts, @skills-runtime/*

### Community 144 - "Community 144"
Cohesion: 0.67
Nodes (3): packages/tool-runtime/src/*, packages/tool-runtime/src/index.ts, @tool-runtime/*

## Knowledge Gaps
- **731 isolated node(s):** `root`, `alias`, `ResolverMap`, `SubagentProgress`, `APPLICATION_BACKGROUND_MIME_TYPES` (+726 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1001 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **28 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `App()` connect `App 主界面与 GPA 交互` to `Community 128`, `Community 130`, `主题与消息浏览器 UI`, `会话流式草稿与工具调用`, `浏览器标签与用量统计`, `实时增强与语音能力`, `Community 15`, `Community 16`, `Community 17`, `Community 22`, `Community 26`, `Community 31`, `Community 32`, `Community 37`, `Community 41`, `Community 43`, `Community 45`, `Community 52`, `Community 66`, `Community 67`, `Community 68`, `Community 69`, `Community 73`, `Community 78`, `Community 79`, `Community 86`, `Community 87`, `Community 91`, `Community 96`, `Community 101`, `Community 102`, `Community 106`, `Community 108`, `Community 127`?**
  _High betweenness centrality (0.093) - this node is a cross-community bridge._
- **Why does `DesktopBackend` connect `桌面后端服务 (DesktopBackend)` to `Community 64`, `Community 65`, `Community 98`, `Community 99`, `Community 100`, `Community 36`, `数据库服务与运行记录`, `Community 102`, `应用背景管理`, `Community 14`, `Community 17`, `Community 19`, `Community 119`, `Community 53`, `Community 23`, `Community 56`, `Community 90`, `Community 31`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._
- **Why does `RuntimeServices` connect `MCP 仓库检查与代理协议` to `Agent 运行时与恢复机制`, `Community 39`, `GPA 计划文件管理`?**
  _High betweenness centrality (0.041) - this node is a cross-community bridge._
- **Are the 23 inferred relationships involving `App()` (e.g. with `addComposerAttachment()` and `beginRenameHistoryThread()`) actually correct?**
  _`App()` has 23 INFERRED edges - model-reasoned connections that need verification._
- **Are the 136 inferred relationships involving `registerIpc()` (e.g. with `.abandonProjectGpaPlan()` and `.addThreadSkill()`) actually correct?**
  _`registerIpc()` has 136 INFERRED edges - model-reasoned connections that need verification._
- **What connects `root`, `alias`, `ResolverMap` to the rest of the system?**
  _731 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `MCP 仓库检查与代理协议` be split into smaller, more focused modules?**
  _Cohesion score 0.015679553100996637 - nodes in this community are weakly interconnected._