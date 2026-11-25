export function slugify(title: string): string {
  return title.toLowerCase();
}

export function renderTitle(title: string, slugify: (t: string) => string): string {
  return slugify(title);
}

export function pageUrl(title: string): string {
  return `/p/${slugify(title)}`;
}

export function page(title: string): string {
  return renderTitle(title, slugify);
}
