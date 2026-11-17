import { el, t } from "./api";
import { iconButton } from "./ui";

export interface ZoomControl {
  /** Elements to append to a toolbar. */
  nodes: HTMLElement[];
  get value(): number;
  set(value: number): void;
}

const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

/** Zoom out / percentage (click resets) / zoom in. Ctrl/Cmd + wheel over `wheelTarget` also zooms. */
export function createZoom(onChange: (value: number) => void, wheelTarget?: HTMLElement, initial = 1): ZoomControl {
  let value = initial;
  const label = el("button", { class: "dv-btn dv-label dv-zoom-label", title: t("zoomReset") });
  label.type = "button";
  label.addEventListener("click", () => set(1));

  function set(next: number) {
    value = Math.min(STEPS[STEPS.length - 1], Math.max(STEPS[0], next));
    label.textContent = `${Math.round(value * 100)}%`;
    onChange(value);
  }

  function step(dir: 1 | -1) {
    const next = dir > 0 ? STEPS.find((s) => s > value + 0.001) : [...STEPS].reverse().find((s) => s < value - 0.001);
    if (next !== undefined) {
      set(next);
    }
  }

  if (wheelTarget) {
    wheelTarget.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          step(e.deltaY < 0 ? 1 : -1);
        }
      },
      { passive: false },
    );
    window.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) {
        return;
      }
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        step(1);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "0") {
        e.preventDefault();
        set(1);
      }
    });
  }

  label.textContent = `${Math.round(value * 100)}%`;
  const group = el("div", { class: "dv-zoom" }, [
    iconButton("minus", t("zoomOut"), () => step(-1)),
    label,
    iconButton("plus", t("zoomIn"), () => step(1)),
  ]);
  return {
    nodes: [group],
    get value() {
      return value;
    },
    set,
  };
}

/** Page number box with previous / next buttons. */
export function createPager(onGo: (page: number) => void, label: string): {
  node: HTMLElement;
  update(current: number, total: number): void;
} {
  let total = 0;
  let current = 1;
  const input = el("input", { class: "dv-input dv-page-input", title: label });
  input.type = "text";
  input.inputMode = "numeric";
  input.setAttribute("aria-label", label);
  const count = el("span", { class: "dv-label" });
  const go = (n: number) => {
    if (Number.isFinite(n) && n >= 1 && n <= total) {
      onGo(n);
    } else {
      input.value = String(current);
    }
  };
  input.addEventListener("change", () => go(parseInt(input.value, 10)));
  input.addEventListener("focus", () => input.select());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      go(parseInt(input.value, 10));
    }
  });
  const node = el("div", { class: "dv-pager" }, [
    iconButton("left", t("prevPage"), () => go(current - 1)),
    input,
    count,
    iconButton("right", t("nextPage"), () => go(current + 1)),
  ]);
  return {
    node,
    update(c: number, n: number) {
      current = c;
      total = n;
      input.value = String(c);
      count.textContent = t("of", n);
    },
  };
}
