"use client";

import type { OptionSchema, OptionValues } from "@/core/types";

const CONTROL =
  "material-control w-full rounded-lg px-3 py-2 type-body text-label outline-none " +
  "transition-colors duration-150 hover:bg-white/[0.07] " +
  "focus:border-accent focus:bg-white/[0.07]";

/**
 * Renders one option from its schema. This is why adding a module needs no
 * frontend change: the module declares its options, the form builds itself.
 *
 * Label sits directly above the control it names — proximity is what makes the
 * mapping obvious without extra explanation.
 */
export function OptionField({
  schema,
  values,
  onChange,
}: {
  schema: OptionSchema;
  values: OptionValues;
  onChange: (key: string, value: string | number | boolean) => void;
}) {
  if (schema.showWhen) {
    const current = values[schema.showWhen.key];
    if (!schema.showWhen.equals.includes(current)) return null;
  }

  const help = schema.help ? (
    <p className="mt-1.5 type-caption text-label-3">{schema.help}</p>
  ) : null;

  const label = (
    <label htmlFor={schema.key} className="block type-body font-medium text-label">
      {schema.label}
    </label>
  );

  if (schema.type === "boolean") {
    const on = Boolean(values[schema.key]);
    return (
      <div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          id={schema.key}
          onClick={() => onChange(schema.key, !on)}
          className="press-sm flex w-full items-center justify-between gap-4 text-left"
        >
          <span className="type-body font-medium text-label">{schema.label}</span>
          <span
            aria-hidden
            className={`relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors duration-200 ${
              on ? "bg-accent" : "bg-white/12"
            }`}
          >
            <span
              className="absolute top-[3px] left-[3px] size-5 rounded-full bg-white shadow-sm
                         transition-transform duration-[280ms]"
              style={{
                transitionTimingFunction: "var(--ease-settle)",
                transform: on ? "translateX(18px)" : "translateX(0)",
              }}
            />
          </span>
        </button>
        {help}
      </div>
    );
  }

  if (schema.type === "select") {
    return (
      <div>
        {label}
        <div className="relative mt-1.5">
          <select
            id={schema.key}
            value={String(values[schema.key] ?? schema.default)}
            onChange={(e) => onChange(schema.key, e.target.value)}
            className={`${CONTROL} cursor-pointer appearance-none pr-9`}
          >
            {schema.choices.map((c) => (
              <option key={c.value} value={c.value} className="bg-raised text-label">
                {c.label}
              </option>
            ))}
          </select>
          <svg
            aria-hidden
            viewBox="0 0 12 12"
            className="pointer-events-none absolute top-1/2 right-3 size-3 -translate-y-1/2 text-label-3"
          >
            <path
              d="M3 4.5 6 7.5 9 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        {help}
      </div>
    );
  }

  if (schema.type === "number") {
    return (
      <div>
        {label}
        <div className="mt-1.5">
          <input
            id={schema.key}
            type="number"
            value={Number(values[schema.key] ?? schema.default)}
            min={schema.min}
            max={schema.max}
            step={schema.step}
            onChange={(e) => onChange(schema.key, Number(e.target.value))}
            className={`${CONTROL} tnum`}
          />
        </div>
        {help}
      </div>
    );
  }

  const isColor = /^#[0-9a-fA-F]{6}$/.test(schema.default);

  return (
    <div>
      {label}
      {schema.multiline ? (
        <textarea
          id={schema.key}
          rows={5}
          value={String(values[schema.key] ?? "")}
          placeholder={schema.placeholder}
          onChange={(e) => onChange(schema.key, e.target.value)}
          className={`${CONTROL} mt-1.5 resize-y font-mono placeholder:text-label-3`}
        />
      ) : (
        <div className="mt-1.5 flex items-center gap-2">
          <input
            id={schema.key}
            type="text"
            value={String(values[schema.key] ?? "")}
            placeholder={schema.placeholder}
            onChange={(e) => onChange(schema.key, e.target.value)}
            className={`${CONTROL} placeholder:text-label-3`}
          />
          {isColor && (
            <label className="relative size-9 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-white/12">
              <span className="sr-only">{schema.label} rengi</span>
              <span
                aria-hidden
                className="absolute inset-0"
                style={{ background: String(values[schema.key] ?? schema.default) }}
              />
              <input
                type="color"
                value={String(values[schema.key] ?? schema.default)}
                onChange={(e) => onChange(schema.key, e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </label>
          )}
        </div>
      )}
      {help}
    </div>
  );
}

/** Initial form state straight from the schema defaults. */
export function defaultValues(options: OptionSchema[]): OptionValues {
  return Object.fromEntries(options.map((o) => [o.key, o.default]));
}
