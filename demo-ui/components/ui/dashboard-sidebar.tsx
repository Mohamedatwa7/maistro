// Original shadcn-style sidebar component (from the user's spec) — kept for a
// future React/Next.js migration. The live site recreates this in vanilla JS
// inside index.html (#sidebar / #topbar / #cmdk).
// Requires: shadcn project structure, Tailwind CSS, TypeScript, lucide-react.
import React, { useState } from 'react';
import {
  Search, LayoutDashboard, FolderKanban, Users, Settings, LogOut, Hash,
  ChevronDown, ChevronRight, Inbox, Calendar, Activity, CreditCard, Globe,
  Terminal, Blocks, PanelLeftClose, PanelLeftOpen, Command, X
} from 'lucide-react';

export type NavItemData = {
  id: string;
  title: string;
  icon: React.ElementType;
  badge?: number | string;
  shortcut?: string;
  children?: NavItemData[];
};

export type NavGroupData = {
  heading?: string;
  items: NavItemData[];
};

// Maistro navigation (adapted from the component's mock data)
const navGroups: NavGroupData[] = [
  {
    items: [
      { id: 'search', title: 'Search', icon: Search, shortcut: '⌘K' },
      { id: 'home', title: 'Home', icon: LayoutDashboard },
    ],
  },
  {
    heading: 'Platform',
    items: [
      { id: 'trends', title: 'Trend Analysis', icon: Activity },
      { id: 'studio', title: 'Content Studio', icon: FolderKanban },
      { id: 'calendar', title: 'Calendar', icon: Calendar },
      { id: 'performance', title: 'Performance', icon: Globe },
    ],
  },
];

const bottomItems: NavItemData[] = [
  { id: 'settings', title: 'Settings', icon: Settings, shortcut: '⌘,' },
  { id: 'logout', title: 'Log out', icon: LogOut },
];

function WorkspaceSwitcher({ selected, onSelect }: { selected?: string; onSelect?: (ws: string) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const [internalSelected, setInternalSelected] = useState('Samsung Gulf');
  const current = selected || internalSelected;
  const handleSelect = onSelect || setInternalSelected;
  const workspaces = ['Samsung Gulf', 'Samsung Egypt', 'Samsung Türkiye'];

  return (
    <div className="relative">
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between px-2 py-2 mb-4 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer transition-colors select-none group"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-[6px] bg-primary text-primary-foreground flex items-center justify-center font-semibold text-[13px] shadow-sm">
            {current.charAt(0)}
          </div>
          <div className="flex flex-col overflow-hidden">
            <span className="text-[13px] font-medium leading-none mb-1 text-foreground truncate max-w-[120px]">{current}</span>
            <span className="text-[11px] text-muted-foreground leading-none">MAISTRO · MENA</span>
          </div>
        </div>
        <ChevronDown className="w-4 h-4 text-muted-foreground/50 group-hover:text-foreground/70 transition-colors shrink-0" strokeWidth={1.5} />
      </div>
      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute top-[52px] left-0 w-full bg-card border border-border/50 rounded-lg shadow-xl z-50 py-1 flex flex-col gap-0.5">
            {workspaces.map((ws) => (
              <div
                key={ws}
                onClick={() => { handleSelect(ws); setIsOpen(false); }}
                className={`px-3 py-2 mx-1 text-[13px] rounded-md cursor-pointer transition-colors ${current === ws ? 'bg-primary/10 text-primary font-medium' : 'text-foreground/80 hover:bg-black/5 dark:hover:bg-white/5'}`}
              >
                {ws}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function NavItem({ item, activeId, onSelect, level = 0 }: {
  item: NavItemData; activeId: string; onSelect: (id: string) => void; level?: number;
}) {
  const isActive = activeId === item.id;
  const hasChildren = !!item.children;
  const [isOpen, setIsOpen] = useState(false);
  const handleClick = () => (hasChildren ? setIsOpen(!isOpen) : onSelect(item.id));

  return (
    <div className="flex flex-col w-full">
      <div
        className={`group flex items-center justify-between px-2.5 py-[7px] rounded-[6px] cursor-pointer transition-all duration-200 select-none ${
          isActive
            ? 'bg-black/5 dark:bg-white/10 text-foreground font-medium'
            : 'text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground/90'
        }`}
        style={{ paddingLeft: `${level * 12 + 10}px` }}
        onClick={handleClick}
      >
        <div className="flex items-center gap-2.5">
          <item.icon className={`w-[16px] h-[16px] ${isActive ? 'text-foreground' : 'text-muted-foreground/70 group-hover:text-foreground/70'}`} strokeWidth={1.5} />
          <span className="text-[13px] tracking-wide truncate">{item.title}</span>
        </div>
        <div className="flex items-center gap-2">
          {item.shortcut && (
            <kbd className="hidden group-hover:inline-flex items-center justify-center h-5 px-1.5 text-[10px] font-medium font-mono text-muted-foreground/60 bg-background/50 border border-border/50 rounded-[4px]">
              {item.shortcut}
            </kbd>
          )}
          {item.badge && (
            <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[10px] font-medium rounded-full bg-primary/10 text-primary">{item.badge}</span>
          )}
          {hasChildren && (
            <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground/50 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`} strokeWidth={2} />
          )}
        </div>
      </div>
      {hasChildren && isOpen && (
        <div className="flex flex-col gap-0.5 mt-0.5">
          {item.children!.map((child) => (
            <NavItem key={child.id} item={child} activeId={activeId} onSelect={onSelect} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function SidebarNav({ className = '', activeId, onSelect, activeWorkspace, onWorkspaceSelect }: {
  className?: string; activeId?: string; onSelect?: (id: string) => void;
  activeWorkspace?: string; onWorkspaceSelect?: (ws: string) => void;
}) {
  const [internalId, setInternalId] = useState('home');
  const currentId = activeId !== undefined ? activeId : internalId;
  const handleSelect = onSelect || setInternalId;

  return (
    <div className={`flex flex-col w-[260px] h-full bg-card/50 border-r border-border/50 p-3 font-sans ${className}`}>
      <WorkspaceSwitcher selected={activeWorkspace} onSelect={onWorkspaceSelect} />
      <div className="flex-1 overflow-y-auto flex flex-col gap-4 mt-2">
        {navGroups.map((group, idx) => (
          <div key={idx} className="flex flex-col gap-0.5">
            {group.heading && (
              <span className="px-2.5 mb-1 text-[11px] font-semibold tracking-wider text-muted-foreground/50 uppercase">{group.heading}</span>
            )}
            {group.items.map((item) => (
              <NavItem key={item.id} item={item} activeId={currentId} onSelect={handleSelect} />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-auto pt-4 border-t border-border/50 flex flex-col gap-0.5">
        {bottomItems.map((item) => (
          <NavItem key={item.id} item={item} activeId={currentId} onSelect={handleSelect} />
        ))}
      </div>
    </div>
  );
}

export default SidebarNav;
