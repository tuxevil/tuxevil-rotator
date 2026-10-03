// The dashboard's pages, shared by the rail, the command palette and the
// document title.

import type { IconName } from "./components/icons.js";
import { BASE, type PageId } from "./state/router.js";

export interface NavItem {
  id: PageId;
  label: string;
  icon: IconName;
  href: string;
  /** Extra words the command palette matches. */
  keywords: string;
}

export const NAV: NavItem[] = [
  { id: "overview", label: "Overview", icon: "overview", href: BASE, keywords: "home status health models pools" },
  { id: "accounts", label: "Accounts", icon: "accounts", href: `${BASE}/accounts`, keywords: "providers quota" },
  { id: "requests", label: "Requests", icon: "requests", href: `${BASE}/requests`, keywords: "traffic logs history live" },
  { id: "usage", label: "Usage", icon: "usage", href: `${BASE}/usage`, keywords: "tokens savings latency heatmap" },
  { id: "keys", label: "Virtual keys", icon: "keys", href: `${BASE}/keys`, keywords: "api clients" },
  { id: "settings", label: "Settings", icon: "settings", href: `${BASE}/settings`, keywords: "policy config benchmark theme" },
];

export const PAGE_TITLES: Record<PageId, string> = Object.fromEntries(NAV.map((item) => [item.id, item.label])) as Record<
  PageId,
  string
>;
