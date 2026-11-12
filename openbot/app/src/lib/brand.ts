import { type AppConfig, appConfig } from "@/lib/generated/application-config";

/*
 * The one place web copy gets the product's names from. They come from the tenant package at build
 * time (appConfig.brand), so mounting a different package renames every sentence without touching
 * code. Each accessor takes the brand as a parameter only so its fallbacks can be tested.
 */
type Brand = AppConfig["brand"];

// The default English name lives here and nowhere else in app/src.
const DEFAULT_ENGLISH_NAME = "XiongBao Work";

export function productName(brand: Brand = appConfig.brand): string {
  return brand.productName;
}

/** What a sentence calls the product once it is known; a package without one is called by its full name. */
export function shortName(brand: Brand = appConfig.brand): string {
  return brand.shortName ?? brand.productName;
}

export function englishName(brand: Brand = appConfig.brand): string {
  return brand.englishName ?? DEFAULT_ENGLISH_NAME;
}

export function companyName(brand: Brand = appConfig.brand): string {
  return brand.companyName ?? brand.productName;
}

export function supportUrl(brand: Brand = appConfig.brand): string | undefined {
  return brand.supportUrl;
}
