const TOP_FADE_CLASS = "has-scroll-fade-top";
const BOTTOM_FADE_CLASS = "has-scroll-fade-bottom";
const SCROLL_EDGE_TOLERANCE = 2;
const EXCLUDED_SCROLL_ELEMENTS = "textarea, input, select, [contenteditable='true'], [data-scroll-fade='off']";

function clearFadeClasses(element: HTMLElement) {
  element.classList.remove(TOP_FADE_CLASS, BOTTOM_FADE_CLASS);
}

function allowsVerticalScrolling(element: HTMLElement) {
  if (element.matches(EXCLUDED_SCROLL_ELEMENTS)) return false;
  const overflowY = window.getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

function updateFadeState(element: HTMLElement) {
  const maxScrollTop = element.scrollHeight - element.clientHeight;
  if (maxScrollTop <= SCROLL_EDGE_TOLERANCE) {
    clearFadeClasses(element);
    return;
  }

  element.classList.toggle(TOP_FADE_CLASS, element.scrollTop > SCROLL_EDGE_TOLERANCE);
  element.classList.toggle(
    BOTTOM_FADE_CLASS,
    element.scrollTop < maxScrollTop - SCROLL_EDGE_TOLERANCE
  );
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
    for (const element of node.querySelectorAll<HTMLElement>("*")) visitor(element);
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
  mutationObserver.observe(root.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "open"]
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
