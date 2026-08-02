import { useMotionPresence } from "../core/motion-presence";
import { useEffect, useRef, useState } from "react";
import { IconChevronDown } from "../icons";

export type ComposerSelectOption = {
  value: string;
  label: string;
};

export function ComposerSelect({
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  className = "",
  ariaLabel,
  searchable = false,
  searchPlaceholder = "筛选选项",
  emptyLabel = "没有可用选项"
}: {
  value: string;
  options: ComposerSelectOption[];
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const menuPresence = useMotionPresence(isOpen ? true : null, 140);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? null;
  const visibleOptions = searchable
    ? options.filter((option) => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    : options;

  useEffect(() => {
    if (disabled && isOpen) {
      setIsOpen(false);
    }
  }, [disabled, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={rootRef} className={`composer-select ${className} ${isOpen ? "open" : ""} ${disabled ? "disabled" : ""}`}>
      <button
        type="button"
        className="composer-select-trigger"
        onClick={() => {
          if (!disabled) {
            setIsOpen((current) => !current);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        <span className="composer-select-value">{selectedOption?.label ?? placeholder}</span>
        <span className="composer-select-chevron">
          <IconChevronDown />
        </span>
      </button>

      {menuPresence.value ? (
        <div className="composer-select-menu" data-motion={menuPresence.phase} role="listbox">
          {searchable ? <input className="composer-select-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder} autoFocus /> : null}
          <div className="composer-select-options">
            {visibleOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`composer-select-option ${option.value === value ? "selected" : ""}`}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                role="option"
                aria-selected={option.value === value}
              >
                {option.label}
              </button>
            ))}
            {visibleOptions.length === 0 ? <span className="composer-select-empty">{emptyLabel}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
