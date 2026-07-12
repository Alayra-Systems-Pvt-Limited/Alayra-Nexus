import {
  LayoutDashboard, Network, Plug, BarChart3, Users, Building2,
  Shield, DatabaseZap, ScrollText, Settings, UserCog,
} from 'lucide-preact';
import type { ComponentType } from 'preact';

export interface Section {
  id: string;
  label: string;
  path: string;
  icon: ComponentType<{ size?: number | string }>;
  /** Grouping for the sidebar: the workspace vs. the system/admin block at the bottom. */
  group: 'workspace' | 'system';
}

// The Phase-7 information architecture. Order and grouping match the redesign brief:
// Overview leads (the active landing plane), the system group (Logs / Settings / Admin) sits
// at the foot behind a divider.
export const SECTIONS: Section[] = [
  { id: 'overview',   label: 'Overview',   path: '/',           icon: LayoutDashboard, group: 'workspace' },
  { id: 'nexus',      label: 'Nexus',      path: '/nexus',      icon: Network,         group: 'workspace' },
  { id: 'connect',    label: 'Connect',    path: '/connect',    icon: Plug,            group: 'workspace' },
  { id: 'analytics',  label: 'Analytics',  path: '/analytics',  icon: BarChart3,       group: 'workspace' },
  { id: 'teams',      label: 'Teams',      path: '/teams',      icon: Users,           group: 'workspace' },
  { id: 'enterprise', label: 'Enterprise', path: '/enterprise', icon: Building2,       group: 'workspace' },
  { id: 'security',   label: 'Security',   path: '/security',   icon: Shield,          group: 'workspace' },
  { id: 'caching',    label: 'Caching',    path: '/caching',    icon: DatabaseZap,     group: 'workspace' },
  { id: 'logs',       label: 'Logs',       path: '/logs',       icon: ScrollText,      group: 'system' },
  { id: 'settings',   label: 'Settings',   path: '/settings',   icon: Settings,        group: 'system' },
  { id: 'admin',      label: 'Admin',      path: '/admin',      icon: UserCog,         group: 'system' },
];

export function sectionByPath(path: string): Section | undefined {
  if (path === '/' || path === '') return SECTIONS[0];
  return SECTIONS.find((s) => s.path !== '/' && (path === s.path || path.startsWith(s.path + '/')));
}
