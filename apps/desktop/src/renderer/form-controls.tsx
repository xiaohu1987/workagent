import { useId, useState } from "react";
import type { ReactNode } from "react";
import "./form-controls.css";

export interface BaseControlProps {
  id?: string;
  label: string;
  required?: boolean;
  error?: string | null;
  help?: string;
  disabled?: boolean;
}

export interface SelectOption {
  label: string;
  value: string;
}

export interface KeyValuePair {
  key: string;
  value: string;
}

export function Field(props: BaseControlProps & { controlId?: string; children: ReactNode }) {
  const autoId = useId();
  const controlId = props.controlId ?? autoId;
  const descriptionIds: string[] = [];
  if (props.error) descriptionIds.push(`${controlId}-error`);
  if (props.help) descriptionIds.push(`${controlId}-help`);
  return (
    <div className={`fc-field${props.error ? " has-error" : ""}`}>
      <label className="fc-label" htmlFor={controlId}>
        <span>{props.label}</span>
        {props.required ? <i className="fc-required" aria-hidden="true" /> : null}
      </label>
      {props.children}
      {props.error ? (
        <div className="fc-error" id={`${controlId}-error`} role="alert">
          {props.error}
        </div>
      ) : null}
      {props.help ? (
        <div className="fc-help" id={`${controlId}-help`}>
          {props.help}
        </div>
      ) : null}
    </div>
  );
}

function describedBy(controlId: string, props: BaseControlProps): string | undefined {
  const ids: string[] = [];
  if (props.error) ids.push(`${controlId}-error`);
  if (props.help) ids.push(`${controlId}-help`);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

export function TextInput(props: BaseControlProps & {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const autoId = useId();
  const controlId = props.id ?? autoId;
  return (
    <Field {...props} controlId={controlId}>
      <input
        id={controlId}
        className="fc-control"
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(controlId, props)}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </Field>
  );
}

export function TextArea(props: BaseControlProps & {
  value: string;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
  onChange: (value: string) => void;
}) {
  const autoId = useId();
  const controlId = props.id ?? autoId;
  return (
    <Field {...props} controlId={controlId}>
      <textarea
        id={controlId}
        className={`fc-control fc-textarea${props.mono ? " fc-mono" : ""}`}
        value={props.value}
        placeholder={props.placeholder}
        rows={props.rows ?? 4}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(controlId, props)}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </Field>
  );
}

export function NumberInput(props: BaseControlProps & {
  value: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: string) => void;
}) {
  const autoId = useId();
  const controlId = props.id ?? autoId;
  return (
    <Field {...props} controlId={controlId}>
      <input
        id={controlId}
        className="fc-control"
        type="number"
        value={props.value}
        placeholder={props.placeholder}
        min={props.min}
        max={props.max}
        step={props.step}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(controlId, props)}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </Field>
  );
}

export function PasswordInput(props: BaseControlProps & {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const autoId = useId();
  const controlId = props.id ?? autoId;
  const [visible, setVisible] = useState(false);
  return (
    <Field {...props} controlId={controlId}>
      <div className="fc-password">
        <input
          id={controlId}
          className="fc-control"
          type={visible ? "text" : "password"}
          value={props.value}
          placeholder={props.placeholder}
          disabled={props.disabled}
          autoComplete="off"
          aria-invalid={props.error ? true : undefined}
          aria-describedby={describedBy(controlId, props)}
          onChange={(event) => props.onChange(event.target.value)}
        />
        <button
          type="button"
          className="fc-password-toggle"
          aria-label={visible ? "隐藏内容" : "显示内容"}
          aria-pressed={visible}
          disabled={props.disabled}
          onClick={() => setVisible((current) => !current)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {visible ? (
              <>
                <path d="M3 3l18 18" />
                <path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c5 0 9.3 3.1 11 7-0.6 1.5-1.6 2.9-2.9 4M6.6 6.6C4.3 7.9 2.6 9.8 1.5 12c1 2.3 2.9 4.3 5.4 5.5A10.6 10.6 0 0 0 12 19c1.2 0 2.3-.2 3.4-.5" />
                <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
              </>
            ) : (
              <>
                <path d="M1 12c1.7-3.9 6-7 11-7s9.3 3.1 11 7c-1.7 3.9-6 7-11 7S2.7 15.9 1 12z" />
                <circle cx="12" cy="12" r="3" />
              </>
            )}
          </svg>
        </button>
      </div>
    </Field>
  );
}

export function SelectInput(props: BaseControlProps & {
  value: string;
  options: SelectOption[];
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const autoId = useId();
  const controlId = props.id ?? autoId;
  return (
    <Field {...props} controlId={controlId}>
      <div className="fc-select">
        <select
          id={controlId}
          className="fc-control"
          value={props.value}
          disabled={props.disabled}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={describedBy(controlId, props)}
          onChange={(event) => props.onChange(event.target.value)}
        >
          {props.placeholder !== undefined ? (
            <option value="" disabled={props.required}>
              {props.placeholder}
            </option>
          ) : null}
          {props.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <svg className="fc-select-caret" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>
    </Field>
  );
}

export function RadioGroup(props: BaseControlProps & {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  const autoId = useId();
  const groupName = props.id ?? autoId;
  return (
    <Field {...props} controlId={groupName}>
      <div className="fc-choices" role="radiogroup" aria-invalid={props.error ? true : undefined}>
        {props.options.map((option) => (
          <label key={option.value} className="fc-choice">
            <input
              type="radio"
              name={groupName}
              value={option.value}
              checked={props.value === option.value}
              disabled={props.disabled}
              onChange={() => props.onChange(option.value)}
            />
            <span className="fc-choice-box fc-choice-radio" aria-hidden="true" />
            <span className="fc-choice-label">{option.label}</span>
          </label>
        ))}
      </div>
    </Field>
  );
}

export function CheckboxGroup(props: BaseControlProps & {
  values: string[];
  options: SelectOption[];
  onChange: (values: string[]) => void;
}) {
  const autoId = useId();
  const groupName = props.id ?? autoId;
  const toggle = (value: string) => {
    if (props.values.includes(value)) {
      props.onChange(props.values.filter((item) => item !== value));
    } else {
      props.onChange([...props.values, value]);
    }
  };
  return (
    <Field {...props} controlId={groupName}>
      <div className="fc-choices" aria-invalid={props.error ? true : undefined}>
        {props.options.map((option) => (
          <label key={option.value} className="fc-choice">
            <input
              type="checkbox"
              name={`${groupName}-${option.value}`}
              value={option.value}
              checked={props.values.includes(option.value)}
              disabled={props.disabled}
              onChange={() => toggle(option.value)}
            />
            <span className="fc-choice-box fc-choice-checkbox" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </span>
            <span className="fc-choice-label">{option.label}</span>
          </label>
        ))}
      </div>
    </Field>
  );
}

export function Switch(props: BaseControlProps & {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const autoId = useId();
  const controlId = props.id ?? autoId;
  return (
    <Field {...props} controlId={controlId}>
      <button
        type="button"
        id={controlId}
        className={`fc-switch${props.checked ? " is-on" : ""}`}
        role="switch"
        aria-checked={props.checked}
        disabled={props.disabled}
        onClick={() => props.onChange(!props.checked)}
      >
        <span className="fc-switch-knob" aria-hidden="true" />
      </button>
    </Field>
  );
}

export function DateInput(props: BaseControlProps & {
  value: string;
  min?: string;
  max?: string;
  onChange: (value: string) => void;
}) {
  const autoId = useId();
  const controlId = props.id ?? autoId;
  return (
    <Field {...props} controlId={controlId}>
      <input
        id={controlId}
        className="fc-control"
        type="date"
        value={props.value}
        min={props.min}
        max={props.max}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(controlId, props)}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </Field>
  );
}

export function TimeInput(props: BaseControlProps & {
  value: string;
  min?: string;
  max?: string;
  step?: number;
  onChange: (value: string) => void;
}) {
  const autoId = useId();
  const controlId = props.id ?? autoId;
  return (
    <Field {...props} controlId={controlId}>
      <input
        id={controlId}
        className="fc-control"
        type="time"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(controlId, props)}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </Field>
  );
}

export function KeyValueEditor(props: BaseControlProps & {
  pairs: KeyValuePair[];
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  onChange: (pairs: KeyValuePair[]) => void;
}) {
  const autoId = useId();
  const controlId = props.id ?? autoId;
  const updatePair = (index: number, patch: Partial<KeyValuePair>) => {
    props.onChange(props.pairs.map((pair, pairIndex) => (pairIndex === index ? { ...pair, ...patch } : pair)));
  };
  const removePair = (index: number) => {
    props.onChange(props.pairs.filter((_, pairIndex) => pairIndex !== index));
  };
  const addPair = () => {
    props.onChange([...props.pairs, { key: "", value: "" }]);
  };
  return (
    <Field {...props} controlId={controlId}>
      <div className="fc-kv" id={controlId}>
        {props.pairs.length > 0 ? (
          <div className="fc-kv-rows">
            {props.pairs.map((pair, index) => (
              <div className="fc-kv-row" key={`${controlId}-row-${index}`}>
                <input
                  className="fc-control fc-mono"
                  type="text"
                  value={pair.key}
                  placeholder={props.keyPlaceholder ?? "键"}
                  disabled={props.disabled}
                  aria-label={`第 ${index + 1} 行的键`}
                  onChange={(event) => updatePair(index, { key: event.target.value })}
                />
                <input
                  className="fc-control fc-mono"
                  type="text"
                  value={pair.value}
                  placeholder={props.valuePlaceholder ?? "值"}
                  disabled={props.disabled}
                  aria-label={`第 ${index + 1} 行的值`}
                  onChange={(event) => updatePair(index, { value: event.target.value })}
                />
                <button
                  type="button"
                  className="fc-kv-remove"
                  aria-label={`删除第 ${index + 1} 行`}
                  disabled={props.disabled}
                  onClick={() => removePair(index)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <button type="button" className="fc-kv-add" disabled={props.disabled} onClick={addPair}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span>{props.addLabel ?? "添加一行"}</span>
        </button>
      </div>
    </Field>
  );
}

export function JsonEditor(props: BaseControlProps & {
  value: string;
  placeholder?: string;
  rows?: number;
  onChange: (value: string) => void;
}) {
  return <TextArea {...props} mono rows={props.rows ?? 6} />;
}
