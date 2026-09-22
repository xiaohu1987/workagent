const TOP_FADE_CLASS = "has-scroll-fade-top";
const BOTTOM_FADE_CLASS = "has-scroll-fade-bottom";
const SCROLL_EDGE_TOLERANCE = 2;
const EXCLUDED_SCROLL_ELEMENTS = "textarea, input, select, [contenteditable='true'], [data-scroll-fade='off']";
const MAX_ADDED_SUBTREE_SCAN = 600;

function clearFadeClasses(element: HTMLElement) {
  element.classList.remove(TOP_FADE_CLASS, BOTTOM_FADE_CLASS);
}

function allowsVerticalScrolling(element: HTMLElement) {
  if (element.matches(EXCLUDED_SCROLL_ELEMENTS)) return false;
  const overflowY = window.getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

/**
 * How many consecutive samples an edge must report the same state before the fade class
 * is committed to the DOM.
 *
 * A transcript pinned to its own growing content reports a different edge state almost
 * every frame: the streamed answer grows, the position is re-pinned one frame later, so
 * the bottom edge samples "not at the end" for that frame and "at the end" immediately
 * after. Committing every sample rewrites `mask-image` on the whole surface sixty times a
 * second, which reads as a flicker and forces a full re-raster of the chat region. An
 * edge therefore only commits once it has been consistently reported.
 */
export const SCROLL_FADE_SETTLE_SAMPLES = 3;

export type ScrollFadeState = {
  top: boolean;
  bottom: boolean;
  topSamples: number;
  bottomSamples: number;
};

const INITIAL_FADE_STATE: ScrollFadeState = {
  top: false,
  bottom: false,
  topSamples: 0,
  bottomSamples: 0
};

const fadeStates = new WeakMap<HTMLElement, ScrollFadeState>();

function settleEdge(current: boolean, samples: number, target: boolean, settleSamples: number) {
  if (current === target) return { value: current, samples: 0 };
  const next = samples + 1;
  return next >= settleSamples
    ? { value: target, samples: 0 }
    : { value: current, samples: next };
}

export function resolveScrollFadeState(
  state: ScrollFadeState,
  desired: { top: boolean; bottom: boolean },
  settleSamples: number = SCROLL_FADE_SETTLE_SAMPLES
): ScrollFadeState {
  const top = settleEdge(state.top, state.topSamples, desired.top, settleSamples);
  const bottom = settleEdge(state.bottom, state.bottomSamples, desired.bottom, settleSamples);
  if (top.value === state.top && bottom.value === state.bottom) {
    if (top.samples === state.topSamples && bottom.samples === state.bottomSamples) return state;
    return {
      top: state.top,
      bottom: state.bottom,
      topSamples: top.samples,
      bottomSamples: bottom.samples
    };
  }
  return {
    top: top.value,
    bottom: bottom.value,
    topSamples: top.samples,
    bottomSamples: bottom.samples
  };
}

function updateFadeState(element: HTMLElement) {
  const previous = fadeStates.get(element) ?? INITIAL_FADE_STATE;
  const maxScrollTop = element.scrollHeight - element.clientHeight;
  if (maxScrollTop <= SCROLL_EDGE_TOLERANCE) {
    fadeStates.set(element, INITIAL_FADE_STATE);
    clearFadeClasses(element);
    return;
  }

  const next = resolveScrollFadeState(previous, {
    top: element.scrollTop > SCROLL_EDGE_TOLERANCE,
    bottom: element.scrollTop < maxScrollTop - SCROLL_EDGE_TOLERANCE
  });
  if (next === previous) return;

  fadeStates.set(element, next);
  element.classList.toggle(TOP_FADE_CLASS, next.top);
  element.classList.toggle(BOTTOM_FADE_CLASS, next.bottom);
}

export function installScrollFades(root: Document = document) {
  const tracked = new Set<HTMLElement>();
  const pending = new Set<HTMLElement>();
  let frameId = 0;

  const flush = () => {
    frameId = 0;
    for (const element of pending) {
      if (element.isConnected && tracked.has(element)) updateFadeState(element);
    }
    pending.clear();
  };

  const schedule = (element: HTMLElement) => {
    pending.add(element);
    if (!frameId) frameId = window.requestAnimationFrame(flush);
  };

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target instanceof HTMLElement) schedule(entry.target);
    }
  });

  const unregister = (element: HTMLElement) => {
    if (!tracked.delete(element)) return;
    pending.delete(element);
    fadeStates.delete(element);
    resizeObserver.unobserve(element);
    clearFadeClasses(element);
  };

  const register = (element: HTMLElement) => {
    if (!allowsVerticalScrolling(element)) {
      unregister(element);
      return;
    }
    if (!tracked.has(element)) {
      tracked.add(element);
      resizeObserver.observe(element);
    }
    schedule(element);
  };

  const visitSubtree = (node: Node, visitor: (element: HTMLElement) => void) => {
    if (!(node instanceof Element)) return;
    if (node instanceof HTMLElement) visitor(node);
    // `visitor` resolves the computed style of every element it receives, so an unbounded
    // walk over a large inserted subtree (a rendered answer, a tool result) forced a style
    // recalc across every node it contained. The cap keeps one insertion bounded; any
    // container that appears later is still picked up by the scroll and resize paths.
    let scanned = 0;
    for (const element of node.querySelectorAll<HTMLElement>("*")) {
      if (scanned >= MAX_ADDED_SUBTREE_SCAN) return;
      scanned += 1;
      visitor(element);
    }
  };

  const scheduleScrollableAncestors = (node: Node) => {
    let element = node instanceof HTMLElement ? node : node.parentElement;
    while (element) {
      if (tracked.has(element)) schedule(element);
      element = element.parentElement;
    }
  };

  visitSubtree(root.documentElement, register);

  const mutationObserver = new MutationObserver((records) => {
    for (const record of records) {
      scheduleScrollableAncestors(record.target);
      if (record.type === "attributes" && record.target instanceof HTMLElement) {
        register(record.target);
      }
      for (const node of record.addedNodes) visitSubtree(node, register);
      for (const node of record.removedNodes) visitSubtree(node, unregister);
    }
  });
  // Deliberately narrow: `characterData` fires for every streamed text frame and `style`
  // fires for every virtual row reposition, so watching either turned the document into a
  // per-frame rescan of scrollable ancestors while an answer was streaming. Only structural
  // changes and the class/open toggles that can introduce or reveal a scroll container are
  // observed now.
  mutationObserver.observe(root.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "open"]
  });

  const handleScroll = (event: Event) => {
    if (event.target instanceof HTMLElement && tracked.has(event.target)) {
      schedule(event.target);
    }
  };
  const handleLoad = (event: Event) => {
    if (event.target instanceof Node) scheduleScrollableAncestors(event.target);
  };
  const handleResize = () => {
    for (const element of tracked) schedule(element);
  };

  root.addEventListener("scroll", handleScroll, true);
  root.addEventListener("load", handleLoad, true);
  window.addEventListener("resize", handleResize);

  return () => {
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    root.removeEventListener("scroll", handleScroll, true);
    root.removeEventListener("load", handleLoad, true);
    window.removeEventListener("resize", handleResize);
    if (frameId) window.cancelAnimationFrame(frameId);
    for (const element of tracked) clearFadeClasses(element);
    tracked.clear();
    pending.clear();
  };
}
