import { useRef, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import "highlight.js/styles/github-dark.css";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);

  const copy = async () => {
    const text = ref.current?.innerText ?? "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard access can be denied; the code stays selectable.
    }
  };

  return (
    <div className="group relative my-3">
      <pre
        ref={ref}
        className="overflow-x-auto rounded-xl border border-white/10 bg-slate-950 p-4 text-xs leading-6"
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        className="absolute right-2 top-2 rounded-md border border-white/10 bg-slate-900/90 px-2 py-1 text-[10px] font-medium text-slate-400 opacity-0 transition group-hover:opacity-100"
      >
        Copy
      </button>
    </div>
  );
}

const components: Components = {
  pre: CodeBlock as Components["pre"],
  a: ({ children, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noreferrer"
      className="text-accent-300 underline decoration-accent-400/40 underline-offset-2"
    >
      {children}
    </a>
  ),
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown text-sm leading-7 text-slate-200">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize, rehypeHighlight]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
