import { contextBridge, ipcRenderer } from "electron";

/**
 * Typed bridge between renderer and main. The renderer gets exactly this API and nothing else.
 */
const api = {
  // Setup (Phase 0)
  setupStatus: () => ipcRenderer.invoke("setup:status"),
  generateKeys: () => ipcRenderer.invoke("setup:generateKeys"),
  saveApiKey: (apiKey: string) => ipcRenderer.invoke("setup:saveApiKey", apiKey),
  saveAnthropicApiKey: (apiKey: string) => ipcRenderer.invoke("setup:saveAnthropicApiKey", apiKey),
  saveBrowserbaseKey: (apiKey: string) => ipcRenderer.invoke("setup:saveBrowserbaseKey", apiKey),
  clearBrowserbaseKey: () => ipcRenderer.invoke("setup:clearBrowserbaseKey"),
  getBalances: () => ipcRenderer.invoke("venue:balances"),
  getCandles: (symbol: string, intervalMinutes: number, sinceMs?: number, untilMs?: number) =>
    ipcRenderer.invoke("venue:candles", symbol, intervalMinutes, sinceMs, untilMs),
  getTickers: (symbols?: string[]) => ipcRenderer.invoke("venue:tickers", symbols),
  getPairs: () => ipcRenderer.invoke("venue:pairs"),
  getTradablePairs: () => ipcRenderer.invoke("pairs:tradable"),
  getVenueInfo: () => ipcRenderer.invoke("venue:info"),
  dbInfo: () => ipcRenderer.invoke("db:info"),
  getLogPath: () => ipcRenderer.invoke("logs:path"),
  getRecentLogs: (maxLines?: number) => ipcRenderer.invoke("logs:recent", maxLines),
  revealLogs: () => ipcRenderer.invoke("logs:reveal"),
  copyToClipboard: (text: string) => ipcRenderer.invoke("clipboard:write", text),
  // Binance WS feed
  subscribeBinanceCandles: (symbol: string, intervalMinutes: number) =>
    ipcRenderer.send("binance:subscribeCandles", symbol, intervalMinutes),
  unsubscribeBinanceCandles: (symbol: string, intervalMinutes: number) =>
    ipcRenderer.send("binance:unsubscribeCandles", symbol, intervalMinutes),
  reportResearchView: (v: { symbol: string; intervalMin: number; bounds: { x: number; y: number; width: number; height: number } | null }) =>
    ipcRenderer.send("research:view", v),
  reportResearchClosed: () => ipcRenderer.send("research:closed"),

  subscribeBinanceTickers: () => ipcRenderer.send("binance:subscribeTickers"),
  unsubscribeBinanceTickers: () => ipcRenderer.send("binance:unsubscribeTickers"),
  onBinanceTickerUpdate: (callback: (data: any[]) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on("binance:ticker-update", handler);
    return () => {
      ipcRenderer.removeListener("binance:ticker-update", handler);
    };
  },
  onCandleUpdate: (callback: (data: { symbol: string; intervalMin: number; candle: any }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on("binance:candle-update", handler);
    return () => {
      ipcRenderer.removeListener("binance:candle-update", handler);
    };
  },
  // Chat (Phase 1)
  getChatHistory: (sessionId: number | null) => ipcRenderer.invoke("chat:history", sessionId),
  clearChatHistory: (sessionId: number | null) => ipcRenderer.invoke("chat:clear", sessionId),
  compactChatHistory: (sessionId: number | null) => ipcRenderer.invoke("chat:compact", sessionId),
  getAiModels: () => ipcRenderer.invoke("chat:models"),
  sendChatMessage: (sessionId: number | null, messages: any[], params?: { model: string; effort: string; capabilities?: { adaptive: boolean; extended: boolean } }) => 
    ipcRenderer.send("chat:send", sessionId, messages, params),
  onChatChunk: (callback: (data: { text: string; conversation?: number | "general" }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on("chat:chunk", handler);
    return () => ipcRenderer.removeListener("chat:chunk", handler);
  },
  onChatComplete: (callback: (data: { conversation?: number | "general" }) => void) => {
    const handler = (_event: any, data: any) => callback(data ?? {});
    ipcRenderer.on("chat:complete", handler);
    return () => ipcRenderer.removeListener("chat:complete", handler);
  },
  onChatError: (callback: (data: { error: string; conversation?: number | "general" }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on("chat:error", handler);
    return () => ipcRenderer.removeListener("chat:error", handler);
  },
  usageReport: () => ipcRenderer.invoke("usage:report"),
  paperAccount: () => ipcRenderer.invoke("paper:account"),
  setPaperBalance: (v: number) => ipcRenderer.invoke("paper:setBalance", v),
  appModeStatus: () => ipcRenderer.invoke("mode:get"),
  setAppMode: (mode: string) => ipcRenderer.invoke("mode:set", mode),
  notifyStatus: () => ipcRenderer.invoke("notify:status"),
  saveTelegram: (botToken: string, chatId: string) =>
    ipcRenderer.invoke("notify:saveTelegram", botToken, chatId),
  clearTelegram: () => ipcRenderer.invoke("notify:clearTelegram"),
  testNotification: () => ipcRenderer.invoke("notify:test"),
  listAgentTools: (model?: string) => ipcRenderer.invoke("agent:tools", model),
  setAgentTool: (id: string, enabled: boolean) => ipcRenderer.invoke("agent:setTool", id, enabled),
  resetAgentTools: () => ipcRenderer.invoke("agent:resetTools"),
  onChatNotice: (callback: (data: { text: string; conversation?: number | "general" }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on("chat:notice", handler);
    return () => ipcRenderer.removeListener("chat:notice", handler);
  },
  // Sessions (Phase 1)
  listSessions: (includeArchived?: boolean) => ipcRenderer.invoke("sessions:list", includeArchived),
  createSession: (pair: string) => ipcRenderer.invoke("sessions:create", pair),
  setSessionStatus: (id: number, status: string) => ipcRenderer.invoke("sessions:setStatus", id, status),
  archivePlan: (id: number) => ipcRenderer.invoke("sessions:archivePlan", id),
  archiveSession: (id: number) => ipcRenderer.invoke("sessions:archive", id),
  onArchiveStep: (callback: (event: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on("sessions:archiveStep", handler);
    return () => ipcRenderer.removeListener("sessions:archiveStep", handler);
  },
  selectSession: (id: number | null) => ipcRenderer.invoke("sessions:select", id),
  getSelectedSession: () => ipcRenderer.invoke("sessions:getSelected"),
  getLastSession: () => ipcRenderer.invoke("sessions:getLast"),
  // Security (app-launch gate)
  checkWindowsHello: () => ipcRenderer.invoke("security:checkWindowsHello"),
  requestWindowsHello: (reason: string) => ipcRenderer.invoke("security:requestWindowsHello", reason),
  // Embedded browser (Phase 1 surface 3)
  browserShow: () => ipcRenderer.invoke("browser:show"),
  browserHide: () => ipcRenderer.invoke("browser:hide"),
  browserSetBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke("browser:setBounds", bounds),
  browserNavigate: (url: string) => ipcRenderer.invoke("browser:navigate", url),
  browserGoHome: () => ipcRenderer.invoke("browser:goHome"),
  browserGoBack: () => ipcRenderer.invoke("browser:goBack"),
  browserGoForward: () => ipcRenderer.invoke("browser:goForward"),
  browserReload: () => ipcRenderer.invoke("browser:reload"),
  browserGetState: () => ipcRenderer.invoke("browser:getState"),
  onBrowserState: (callback: (state: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on("browser:state", handler);
    return () => ipcRenderer.removeListener("browser:state", handler);
  },
  // Phase 2: Alert triggers (pushed live from the alert engine)
  onAlertTriggered: (callback: (event: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on("alerts:triggered", handler);
    return () => ipcRenderer.removeListener("alerts:triggered", handler);
  },
  // Agent navigation — the agent navigates the UI to the surface it's working on
  // so the user sees what the agent sees (e.g. switches to Research before taking
  // a screenshot of the chart).
  onAgentNavigate: (callback: (surface: string) => void) => {
    const handler = (_event: any, surface: string) => callback(surface);
    ipcRenderer.on("agent:navigate", handler);
    return () => ipcRenderer.removeListener("agent:navigate", handler);
  },
  onAgentActing: (callback: (acting: boolean) => void) => {
    const handler = (_event: any, acting: boolean) => callback(acting);
    ipcRenderer.on("agent:acting", handler);
    return () => ipcRenderer.removeListener("agent:acting", handler);
  },
  onDataUpdated: (callback: (data: { kind: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on("data:updated", handler);
    return () => ipcRenderer.removeListener("data:updated", handler);
  },
  // Phase 2: Strategies
  listStrategies: (sessionId: number) => ipcRenderer.invoke("strategies:list", sessionId),
  getStrategy: (id: number) => ipcRenderer.invoke("strategies:get", id),
  setStrategyState: (id: number, state: string) => ipcRenderer.invoke("strategies:setState", id, state),
  deleteStrategy: (id: number) => ipcRenderer.invoke("strategies:delete", id),
  // Phase 2: Backtests
  getAnalysisCandles: (symbol: string, intervalMinutes: number, limit?: number) =>
    ipcRenderer.invoke("candles:analysis", symbol, intervalMinutes, limit),
  getTickerSnapshot: () => ipcRenderer.invoke("candles:tickerSnapshot"),
  getDerivatives: (symbol: string) => ipcRenderer.invoke("derivatives:get", symbol),
  getBasisStats: (symbol: string, sinceMs?: number) => ipcRenderer.invoke("basis:stats", symbol, sinceMs),

  // Order flow — computed in main, rendered by the chart (S1-4)
  getCvdSeries: (symbol: string, intervalMin: number, opts?: { anchorMs?: number; limit?: number }) =>
    ipcRenderer.invoke("insights:cvd", symbol, intervalMin, opts),
  getVolumeProfile: (req: unknown) => ipcRenderer.invoke("insights:volumeProfile", req),

  // Candle history coverage + repair (S1-3)
  getCandleCoverage: () => ipcRenderer.invoke("candles:coverage"),
  repairCandleHistory: (symbol?: string, intervalMin?: number) =>
    ipcRenderer.invoke("candles:repair", symbol, intervalMin),
  onCandleRepairProgress: (cb: (p: unknown) => void) => {
    const handler = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on("candles:repairProgress", handler);
    return () => ipcRenderer.removeListener("candles:repairProgress", handler);
  },

  listPaperPositions: (sessionId: number, strategyId?: number) =>
    ipcRenderer.invoke("paper:listPositions", sessionId, strategyId),
  getPaperStats: (sessionId: number) => ipcRenderer.invoke("paper:stats", sessionId),
  getPaperEquityCurve: (sessionId: number) => ipcRenderer.invoke("paper:equityCurve", sessionId),
  getStrategyComparisons: (sessionId: number) => ipcRenderer.invoke("paper:strategyComparisons", sessionId),

  listOrders: (sessionId: number, limit?: number) => ipcRenderer.invoke("orders:list", sessionId, limit),
  approveOrder: (orderId: number) => ipcRenderer.invoke("orders:approve", orderId),
  rejectOrder: (orderId: number) => ipcRenderer.invoke("orders:reject", orderId),
  listJournal: (sessionId: number, opts?: { kind?: string; query?: string; limit?: number }) =>
    ipcRenderer.invoke("journal:list", sessionId, opts),
  journalCounts: (sessionId: number) => ipcRenderer.invoke("journal:counts", sessionId),
  listActivity: (limit?: number) => ipcRenderer.invoke("activity:list", limit),
  listSessionActivity: (sessionId: number, limit?: number) =>
    ipcRenderer.invoke("activity:listForSession", sessionId, limit),
  portfolioSummary: (includeArchived?: boolean) => ipcRenderer.invoke("portfolio:summary", includeArchived),

  tripKillSwitch: (reason?: string) => ipcRenderer.invoke("killSwitch:trip", reason),
  resetKillSwitch: () => ipcRenderer.invoke("killSwitch:reset"),
  getKillSwitchStatus: () => ipcRenderer.invoke("killSwitch:status"),

  listDrawings: (symbol: string, intervalMin?: number) => ipcRenderer.invoke("drawings:list", symbol, intervalMin),
  saveDrawing: (d: unknown) => ipcRenderer.invoke("drawings:save", d),
  deleteDrawing: (id: number) => ipcRenderer.invoke("drawings:delete", id),
  clearDrawings: (symbol: string) => ipcRenderer.invoke("drawings:clear", symbol),

  // Plan references (S2-2): the semantic layer the chart and the engine share.
  listLevelReferences: (symbol: string, intervalMin?: number) =>
    ipcRenderer.invoke("levels:list", symbol, intervalMin),
  promoteDrawing: (drawingId: number, opts?: unknown) =>
    ipcRenderer.invoke("levels:promote", drawingId, opts),
  deleteLevelReference: (id: number) => ipcRenderer.invoke("levels:delete", id),

  // Scenario plans (S3-1/S3-2).
  listPlans: (sessionId: number, states?: string[]) => ipcRenderer.invoke("plans:list", sessionId, states),
  getPlan: (id: number) => ipcRenderer.invoke("plans:get", id),
  createPlan: (input: unknown) => ipcRenderer.invoke("plans:create", input),
  updatePlan: (id: number, input: unknown) => ipcRenderer.invoke("plans:update", id, input),
  deletePlan: (id: number) => ipcRenderer.invoke("plans:delete", id),
  armPlan: (id: number) => ipcRenderer.invoke("plans:arm", id),
  dryRunPlan: (id: number) => ipcRenderer.invoke("plans:dryRun", id),
  planCalibration: (sessionId?: number) => ipcRenderer.invoke("plans:calibration", sessionId),
  transitionPlan: (id: number, to: string, reason?: string) =>
    ipcRenderer.invoke("plans:transition", id, to, reason),

  listBacktests: (sessionId: number) => ipcRenderer.invoke("backtests:list", sessionId),
  getBacktestResult: (id: number) => ipcRenderer.invoke("backtests:get", id),
  // Phase 2: Alerts
  listAlerts: (sessionId?: number) => ipcRenderer.invoke("alerts:list", sessionId),
  removeAlert: (alertId: number) => ipcRenderer.invoke("alerts:remove", alertId),
  // Phase 2: Indicators
  listIndicatorCatalog: () => ipcRenderer.invoke("indicators:list"),
  computeIndicators: (symbol: string, intervalMin: number, indicators: any[], limit?: number) =>
    ipcRenderer.invoke("indicators:compute", symbol, intervalMin, indicators, limit),
  // Window controls (custom titlebar)
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowMaximize: () => ipcRenderer.invoke("window:maximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  onQuitRequested: (callback: (summary: any) => void) => {
    const handler = (_event: any, summary: any) => callback(summary);
    ipcRenderer.on("app:quitRequested", handler);
    return () => ipcRenderer.removeListener("app:quitRequested", handler);
  },
  quitShown: () => ipcRenderer.invoke("app:quitShown"),
  answerQuit: (quit: boolean) => ipcRenderer.invoke("app:quitAnswer", quit),
};

export type RendererApi = typeof api;

contextBridge.exposeInMainWorld("api", api);

