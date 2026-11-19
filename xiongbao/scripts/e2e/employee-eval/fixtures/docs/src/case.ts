function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** `hello world` → `helloWorld` */
export function toCamelCase(input: string): string {
  return words(input)
    .map((word, index) =>
      index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join("");
}

/** `helloWorld` → `hello-world` */
export function toKebabCase(input: string): string {
  return words(input).join("-");
}
