import { useEffect } from "react";

export function Toasts({ messages, onClear }: { messages: string[], onClear: () => void }) {
  useEffect(() => {
    if (!messages.length) return;
    const t = setTimeout(onClear, 4000);
    return () => clearTimeout(t);
  }, [messages, onClear]);

  if (!messages.length) return null;

  return (
    <div className="toasts">
      {messages.map((m, i) => (
        <div className="toast" key={i} role="status" aria-live="polite">{m}</div>
      ))}
    </div>
  );
}
