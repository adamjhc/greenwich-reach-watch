function el(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`#${id}`);
  if (!element) {
    throw new Error(`#${id} is missing from the page`);
  }
  return element;
}

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function narrow(): boolean {
  return matchMedia('(max-width: 800px)').matches;
}

export { el, narrow, reduceMotion };
