import { Check } from "@phosphor-icons/react";
import type { ReactNode } from "react";

export type StepItem = {
  id: string;
  title: string;
  description?: string;
  status: "done" | "current" | "pending";
  content: ReactNode;
};

export function StepGuide({ steps }: { steps: StepItem[] }) {
  return (
    <ol className="flex flex-col gap-5">
      {steps.map((step, index) => {
        const done = step.status === "done";
        const current = step.status === "current";
        return (
          <li key={step.id} className="relative flex gap-4">
            {index < steps.length - 1 && (
              <span
                aria-hidden
                className="absolute start-3.5 top-8 bottom-[-1.25rem] w-px bg-kumo-line"
              />
            )}
            <span
              className={`relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                done
                  ? "border-transparent text-white"
                  : current
                    ? "border-kumo-interact bg-kumo-base text-kumo-strong ring-2 ring-kumo-line"
                    : "border-kumo-line bg-kumo-recessed text-kumo-subtle"
              }`}
              style={done ? { background: "var(--brand-accent)" } : undefined}
              aria-hidden
            >
              {done ? <Check size={14} weight="bold" /> : index + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-3 pb-1">
              <div>
                <h3 className="text-sm font-semibold text-kumo-strong">{step.title}</h3>
                {step.description && <p className="mt-0.5 text-xs text-kumo-subtle">{step.description}</p>}
              </div>
              <div className="flex min-w-0 flex-col gap-3">{step.content}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
