import { useCallback, useEffect, useRef, useState } from "react";
import { api, isError, type ChatMessage, errorText } from "@/lib/api";
import { Send, Bot, User, Loader2, Terminal, AlertTriangle, Trash2, BookmarkPlus, Wrench, RotateCw } from "lucide-react";
import { ToolsMenu } from "@/components/tools-menu";
import { renderMarkdown } from "@/lib/markdown";

interface ChatPanelProps {
  sessionId: number | null;
}

/**
 * One assistant turn, split on the tool markers the main process emits.
 *
 * A single reply can span many agentic rounds — think, call a tool, think
 * again. Rendering the concatenated text as one blob is why replies read as
 * "Perfect! Let me finalize…Excellent! Now let me backtest it:Still zero
 * trades." Splitting on the markers restores the shape of what actually
 * happened, and makes the tool calls visible rather than implied.
 */
function AssistantMessage({ text }: { text: string }) {
  const parts = text.split(/\[\[(tool|toolerror):([^\]]*)\]\]/g);
  const nodes: React.ReactNode[] = [];

  // split() with 2 capture groups yields [text, kind, payload, text, ...]
  for (let i = 0; i < parts.length; ) {
    const body = parts[i] ?? "";
    if (body.trim()) {
      nodes.push(
        <div key={`t${i}`} className="chat-bubble chat-bubble-agent md">
          {renderMarkdown(body.trim())}
        </div>
      );
    }
    const kind = parts[i + 1];
    const payload = parts[i + 2];
    if (kind && payload !== undefined) {
      if (kind === "tool") {
        nodes.push(
          <div key={`c${i}`} className="chat-tool">
            <Terminal size={12} style={{ color: "var(--ai)" }} />
            <span className="mono">{payload}</span>
          </div>
        );
      } else {
        const [name, ...rest] = payload.split(":");
        nodes.push(
          <div key={`c${i}`} className="chat-tool chat-tool-error">
            <AlertTriangle size={12} />
            <span className="mono">{name}</span>
            <span className="chat-tool-msg">{rest.join(":")}</span>
          </div>
        );
      }
      i += 3;
    } else {
      i += 1;
    }
  }

  if (nodes.length === 0) return <div className="chat-bubble chat-bubble-agent" />;
  return <div className="chat-turn">{nodes}</div>;
}

export function ChatPanel({ sessionId }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* A notice is not a failure — the turn is still running or has succeeded with
     one capability fewer. Styling it like an error would train you to ignore
     the real ones. */
  const [notice, setNotice] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  /* "loading" and "failed" are different facts. An expired key used to come
     back as an empty list, which this panel rendered as "Loading models..."
     for ever. */
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [model, setModel] = useState("claude-opus-4-8"); // Fallback default
  const [effort, setEffort] = useState("high");
  const [attachedImage, setAttachedImage] = useState<{ data: string; type: string } | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Fetch available models — on open, on Retry, and whenever the key is saved
  const loadModels = useCallback(async () => {
    setModelsError(null);
    const res = await api.getAnthropicModels();
    if (isError(res)) {
      setAvailableModels([]);
      setModelsError(errorText(res));
    } else if (res.length === 0) {
      setAvailableModels([]);
      setModelsError("This Anthropic key has no models available.");
    } else {
      setAvailableModels(res);
    }
  }, []);

  useEffect(() => {
    void loadModels();
    return api.onDataUpdated(({ kind }) => {
      if (kind === "credentials") void loadModels();
    });
  }, [loadModels]);

  // Set model/effort based on saved session state or defaults
  useEffect(() => {
    if (!sessionId || availableModels.length === 0) return;

    const savedModel = localStorage.getItem(`chat_model_${sessionId}`);
    const savedEffort = localStorage.getItem(`chat_effort_${sessionId}`);
    
    if (savedModel && availableModels.find(m => m.id === savedModel)) {
      setModel(savedModel);
    } else {
      // Default to the most cost-efficient model (Haiku) if available
      const haikuModel = availableModels.find((m: any) => m.id.includes("haiku"));
      if (haikuModel) setModel(haikuModel.id);
      else setModel(availableModels[0].id);
    }

    if (savedEffort) setEffort(savedEffort);
    else setEffort("high");
  }, [sessionId, availableModels]);


  // Load history when session changes
  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    api.getChatHistory(sessionId).then((res) => {
      if (!isError(res)) {
        setMessages(res);
      }
    });
  }, [sessionId]);

  // Setup stream listeners
  useEffect(() => {
    const unsubChunk = api.onChatChunk(({ text }) => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant" && !last.id) {
          // Append to the ongoing streaming message
          return [...prev.slice(0, -1), { ...last, content: last.content + text }];
        } else {
          // Create new streaming message
          return [...prev, { role: "assistant", content: text, timestamp: Date.now() }];
        }
      });
    });

    const unsubComplete = api.onChatComplete(() => {
      setIsStreaming(false);
      // Optional: re-fetch history to get real DB IDs
      if (sessionId) {
        api.getChatHistory(sessionId).then((res) => {
          if (!isError(res)) setMessages(res);
        });
      }
    });

    const unsubError = api.onChatError(({ error }) => {
      setError(error);
      setIsStreaming(false);
    });

    const unsubNotice = api.onChatNotice(({ text }) => setNotice(text));

    return () => {
      unsubChunk();
      unsubComplete();
      unsubError();
      unsubNotice();
    };
  }, [sessionId]);

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = () => {
    if ((!input.trim() && !attachedImage) || !sessionId || isStreaming) return;

    let content: any = input;
    if (attachedImage) {
      content = [
        { type: "text", text: input || "Check out this image:" },
        { type: "image", source: { type: "base64", media_type: attachedImage.type, data: attachedImage.data } }
      ];
    }

    const userMsg: ChatMessage = { 
      role: "user", 
      content: attachedImage ? "[Attached Image] " + input : input, 
      timestamp: Date.now() 
    };
    
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setAttachedImage(null);
    setError(null);
    setNotice(null);
    setIsStreaming(true);

    const selectedModel = availableModels.find(m => m.id === model);
    const capabilities = selectedModel?.capabilities || {};
    const adaptive = capabilities.effort?.supported ?? false;
    const extended = capabilities.thinking?.supported ?? false;

    api.sendChatMessage(
      sessionId, 
      newMessages.map((m, i) => ({ 
        role: m.role, 
        content: i === newMessages.length - 1 ? content : m.content 
      })), 
      { model, effort, capabilities: { adaptive, extended } }
    );
  };

  const handleClearChat = async () => {
    if (!sessionId || isStreaming) return;
    await api.clearChatHistory(sessionId);
    setMessages([]);
    setError(null);
  };

  const handleCompactChat = async () => {
    if (!sessionId || isStreaming || isCompacting || messages.length <= 4) return;
    setIsCompacting(true);
    setError(null);
    const res = await api.compactChatHistory(sessionId);
    setIsCompacting(false);
    if (!isError(res) && res.ok) {
      const updated = await api.getChatHistory(sessionId);
      if (!isError(updated)) setMessages(updated);
    } else {
      // `compact` has its own domain-level failure (too few messages) distinct
      // from an IPC error, so both shapes need handling.
      const errMsg = isError(res) ? errorText(res) : (res.error ?? "Couldn't compact this conversation.");
      setError(errMsg);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item && item.type.indexOf("image") !== -1) {
        // Restrict to common safe formats
        if (!["image/png", "image/jpeg", "image/webp"].includes(item.type)) {
          setError(`Unsupported image type: ${item.type}. Please paste a PNG, JPEG, or WebP.`);
          continue;
        }

        const file = item.getAsFile();
        if (file) {
          const reader = new FileReader();
          reader.onload = (event) => {
            const result = event.target?.result as string | undefined;
            if (result) {
              // Sanitize: load into an Image, draw to Canvas (strips EXIF), and optionally resize
              const img = new Image();
              img.onload = () => {
                const MAX_WIDTH = 1280; // Same max width used by screenshot_browser tool
                let width = img.width;
                let height = img.height;

                if (width > MAX_WIDTH) {
                  height = Math.round((height * MAX_WIDTH) / width);
                  width = MAX_WIDTH;
                }

                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext("2d");
                if (ctx) {
                  ctx.drawImage(img, 0, 0, width, height);
                  // Export as clean PNG
                  const dataUrl = canvas.toDataURL("image/png");
                  const base64Data = dataUrl.split(',')[1];
                  if (base64Data) {
                    setAttachedImage({ data: base64Data, type: "image/png" });
                  }
                }
              };
              img.src = result;
            }
          };
          reader.readAsDataURL(file);
          e.preventDefault();
          break; // Only handle the first pasted image
        }
      }
    }
  };

  if (!sessionId) {
    return (
      <div className="flex-1 flex items-center justify-center border-l border-border bg-card p-4">
        <p className="text-sm text-muted-foreground text-center">Select a session to start chatting.</p>
      </div>
    );
  }

  const selectedModelData = availableModels.find(m => m.id === model);
  const isEffortSupported = selectedModelData?.capabilities?.effort?.supported || selectedModelData?.capabilities?.thinking?.supported;

  return (
    /* Fills whatever container it's given. It used to set its own responsive
       widths and left border, which now fight the 380px chat drawer that
       wraps it — the drawer owns width and chrome. */
    <div className="flex h-full min-h-0 w-full flex-col bg-card">
      {/* Header */}
      {/* No title here — the drawer header above already says "Agent". This
          row is just the model/effort controls. */}
      <div className="flex flex-col gap-2 border-b border-border px-3 py-2">
          <div className="flex items-center gap-2 text-xs">
            <select 
              value={model} 
              onChange={e => {
                const newModel = e.target.value;
                setModel(newModel);
                if (sessionId) localStorage.setItem(`chat_model_${sessionId}`, newModel);
                /* Say what the change does and, just as importantly, what it
                   does not do. The conversation carries over verbatim, so the
                   new model reads the old one's replies as its own — which is
                   fine, but it is not a fresh start and the transcript would
                   otherwise give no sign the author changed. */
                if (messages.length > 0) {
                  const name = availableModels.find((m) => m.id === newModel)?.display_name ?? newModel;
                  setNotice(`${name} takes over from your next message. This conversation carries over.`);
                }
              }}
              className="bg-secondary border border-border rounded px-2 py-1.5 focus:outline-none flex-1 font-medium truncate disabled:opacity-50"
              /* Not changeable mid-turn: the request in flight already has its
                 model, so accepting a change here would leave the control
                 naming one model while another is answering — an ambiguous
                 state, which outranks the convenience. */
              disabled={availableModels.length === 0 || isStreaming}
              title={isStreaming ? "Wait for the current reply to finish" : "Model for your next message"}
            >
              {availableModels.length === 0 ? (
                <option value={model}>{modelsError ? "Models unavailable" : "Loading models..."}</option>
              ) : (
                availableModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name}
                  </option>
                ))
              )}
            </select>
            
            {/* Show Effort if adaptive thinking OR extended thinking is supported */}
            {isEffortSupported ? (
              <select 
                value={effort} 
                onChange={e => {
                  const newEffort = e.target.value;
                  setEffort(newEffort);
                  if (sessionId) localStorage.setItem(`chat_effort_${sessionId}`, newEffort);
                }}
                className="bg-secondary border border-border rounded px-2 py-1.5 focus:outline-none w-24 font-medium"
              >
                <option value="low">Low Effort</option>
                <option value="medium">Med Effort</option>
                <option value="high">High Effort</option>
              </select>
            ) : null}

            <div style={{ position: "relative" }}>
              <button
                onClick={() => setToolsOpen((v) => !v)}
                title="Choose what the agent can do"
                className="p-1.5 text-muted-foreground hover:text-accent border border-border rounded bg-secondary shrink-0 cursor-pointer"
              >
                <Wrench size={13} />
              </button>
              {toolsOpen && <ToolsMenu model={model} onClose={() => setToolsOpen(false)} />}
            </div>

            <button
              onClick={() => void handleCompactChat()}
              disabled={!sessionId || isStreaming || isCompacting || messages.length <= 4}
              title="Summarise older messages (the journal keeps the full record)"
              className="p-1.5 text-muted-foreground hover:text-ai border border-border rounded bg-secondary disabled:opacity-30 disabled:hover:text-muted-foreground shrink-0 cursor-pointer"
            >
              {isCompacting ? <Loader2 size={13} className="animate-spin" /> : <BookmarkPlus size={13} />}
            </button>

            <button
              onClick={() => void handleClearChat()}
              disabled={!sessionId || isStreaming || messages.length === 0}
              title="Clear this chat (journal and memory are kept)"
              className="p-1.5 text-muted-foreground hover:text-destructive border border-border rounded bg-secondary disabled:opacity-30 disabled:hover:text-muted-foreground shrink-0 cursor-pointer"
            >
              <Trash2 size={13} />
            </button>
          </div>
          {modelsError && (
            <div className="flex items-center gap-2 text-xs text-destructive" role="alert">
              <AlertTriangle size={12} className="shrink-0" />
              <span className="flex-1">{modelsError}</span>
              <button
                onClick={() => void loadModels()}
                className="flex items-center gap-1 rounded border border-border bg-secondary px-2 py-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <RotateCw size={11} /> Retry
              </button>
            </div>
          )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-xs text-muted-foreground text-center p-3 bg-secondary/40 rounded-md border border-border/50 space-y-1">
            <div className="font-medium text-foreground">Chat log is clear.</div>
            <div className="text-text-faint">
              Session journal entries & distilled lessons remain preserved in SQLite memory and system context.
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-2 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
            <div
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                msg.role === "user" ? "bg-primary/20 text-primary" : "bg-secondary text-secondary-foreground"
              }`}
            >
              {msg.role === "user" ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
            </div>
            {msg.role === "user" ? (
              <div className="chat-bubble chat-bubble-user">{String(msg.content)}</div>
            ) : (
              <AssistantMessage text={String(msg.content)} />
            )}
          </div>
        ))}
        {notice && <div className="chat-notice">{notice}</div>}
        {error && (
          <div className="text-xs text-destructive text-center p-2 bg-destructive/10 rounded-md">
            {error}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-border flex flex-col gap-2">
        {attachedImage && (
          <div className="relative inline-block self-start">
            <img src={`data:${attachedImage.type};base64,${attachedImage.data}`} className="h-20 rounded-md border border-border object-cover" />
            <button 
              onClick={() => setAttachedImage(null)}
              className="absolute -top-2 -right-2 bg-destructive text-destructive-foreground rounded-full w-5 h-5 flex items-center justify-center text-xs hover:bg-destructive/90"
            >
              ×
            </button>
          </div>
        )}
        <form 
          onSubmit={(e) => { e.preventDefault(); handleSend(); }}
          onPaste={handlePaste}
          className="relative flex items-center"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isStreaming}
            placeholder={isStreaming ? "Claude is thinking..." : "Ask Claude or paste an image..."}
            className="w-full bg-secondary border border-border rounded-md pl-3 pr-10 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={(!input.trim() && !attachedImage) || isStreaming}
            className="absolute right-2 p-1 text-muted-foreground hover:text-primary disabled:opacity-50 disabled:hover:text-muted-foreground"
          >
            {isStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </form>
      </div>
    </div>
  );
}
