/** Small shared controls, in plain HTML and styles.css. */
import type { ReactNode } from "react";

export function Field({ label, tip, children }: { label: string; tip?: string; children: ReactNode }) {
  return (
    <div className="field">
      <span title={tip}>{label}</span>
      {children}
    </div>
  );
}

/** One choice from a few, as a row of buttons. */
export function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; text: ReactNode }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          {o.text}
        </button>
      ))}
    </div>
  );
}

export function Callout({ kind, title, children }: { kind: "error" | "warn" | "ok"; title: string; children?: ReactNode }) {
  return (
    <div className={`callout ${kind}`} role={kind === "error" ? "alert" : undefined}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function UsbIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v14" /><path d="M9 6l3-3 3 3" /><circle cx="12" cy="19" r="2" />
      <path d="M12 13l-5-3V8" /><rect x="5.5" y="6" width="3" height="2" /><path d="M12 11l5-2V7" /><circle cx="17" cy="6" r="1.2" />
    </svg>
  );
}
