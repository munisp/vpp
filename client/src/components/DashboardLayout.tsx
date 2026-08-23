import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { APP_LOGO, APP_TITLE, getLoginUrl } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import {
  NavGroup,
  findNavItem,
  getNavGroups,
  groupIdForPath,
  readOpenGroups,
  searchNavItems,
  writeOpenGroups,
} from "@/lib/nav";
import { ChevronRight, LogOut, PanelLeft, Search } from "lucide-react";
import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from './DashboardLayoutSkeleton';
import { Button } from "./ui/button";
import { NotificationCenter } from './NotificationCenter';
import { NAV_ICONS } from '@/lib/nav-icons';

function NavIcon({ path, isActive }: { path: string; isActive: boolean }) {
  const Icon = NAV_ICONS[path];
  if (!Icon) {
    return <span className="h-4 w-4 flex items-center justify-center text-xs">&bull;</span>;
  }
  return <Icon className={`h-4 w-4 ${isActive ? "text-primary" : ""}`} />;
}

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user } = useAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (loading) {
    return <DashboardLayoutSkeleton />
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-8 p-8 max-w-md w-full">
          <div className="flex flex-col items-center gap-6">
            <div className="relative group">
              <div className="relative">
                <img
                  src={APP_LOGO}
                  alt={APP_TITLE}
                  className="h-20 w-20 rounded-xl object-cover shadow"
                />
              </div>
            </div>
            <div className="text-center space-y-2">
              <h1 className="text-2xl font-bold tracking-tight">{APP_TITLE}</h1>
              <p className="text-sm text-muted-foreground">
                Please sign in to continue
              </p>
            </div>
          </div>
          <Button
            onClick={() => {
              window.location.href = getLoginUrl();
            }}
            size="lg"
            className="w-full shadow-lg hover:shadow-xl transition-all"
          >
            Sign in
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

type DashboardLayoutContentProps = {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
};

function DashboardLayoutContent({
  children,
  setSidebarWidth,
}: DashboardLayoutContentProps) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const navGroups = useMemo(() => getNavGroups(user?.role), [user?.role]);
  const activeMenuItem = findNavItem(navGroups, location);
  const isMobile = useIsMobile();
  const [filter, setFilter] = useState("");
  const [openGroups, setOpenGroups] = useState<string[]>(() =>
    readOpenGroups(localStorage, navGroups, location)
  );
  const filterMatches = useMemo(
    () => searchNavItems(navGroups, filter),
    [navGroups, filter]
  );

  // Reveal the group owning the route the user just navigated to, without
  // closing whatever else they had open.
  useEffect(() => {
    const groupId = groupIdForPath(
      navGroups.filter(group => !group.pinned),
      location
    );
    if (!groupId) return;
    setOpenGroups(previous =>
      previous.includes(groupId) ? previous : [...previous, groupId]
    );
  }, [location, navGroups]);

  useEffect(() => {
    writeOpenGroups(localStorage, openGroups);
  }, [openGroups]);

  const navigate = (path: string) => {
    setFilter("");
    setLocation(path);
  };

  const renderItems = (items: NavGroup["items"]) => (
    <SidebarMenu className="px-2 py-1">
      {items.map(item => {
        const isActive = location === item.path;
        return (
          <SidebarMenuItem key={item.path}>
            <SidebarMenuButton
              isActive={isActive}
              onClick={() => navigate(item.path)}
              tooltip={item.label}
              className="h-9 transition-all font-normal"
            >
              <NavIcon path={item.path} isActive={isActive} />
              <span>{item.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );

  useEffect(() => {
    if (isCollapsed) {
      setIsResizing(false);
    }
  }, [isCollapsed]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = e.clientX - sidebarLeft;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar
          collapsible="icon"
          className="border-r-0"
          disableTransition={isResizing}
        >
          <SidebarHeader className="h-16 justify-center">
            <div className="flex items-center gap-3 pl-2 group-data-[collapsible=icon]:px-0 transition-all w-full">
              {isCollapsed ? (
                <div className="relative h-8 w-8 shrink-0 group">
                  <img
                    src={APP_LOGO}
                    className="h-8 w-8 rounded-md object-cover ring-1 ring-border"
                    alt="Logo"
                  />
                  <button
                    onClick={toggleSidebar}
                    className="absolute inset-0 flex items-center justify-center bg-accent rounded-md ring-1 ring-border opacity-0 group-hover:opacity-100 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <PanelLeft className="h-4 w-4 text-foreground" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3 min-w-0">
                    <img
                      src={APP_LOGO}
                      className="h-8 w-8 rounded-md object-cover ring-1 ring-border shrink-0"
                      alt="Logo"
                    />
                    <span className="font-semibold tracking-tight truncate">
                      {APP_TITLE}
                    </span>
                  </div>
                  <button
                    onClick={toggleSidebar}
                    className="ml-auto h-8 w-8 flex items-center justify-center hover:bg-accent rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                  >
                    <PanelLeft className="h-4 w-4 text-muted-foreground" />
                  </button>
                </>
              )}
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-0">
            {isCollapsed ? (
              // Icon rail: a collapsed group would hide its icons entirely, so
              // every route stays reachable as a flat list of icons.
              renderItems(navGroups.flatMap(group => group.items))
            ) : (
              <>
                <div className="px-3 pt-2 pb-1">
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={filter}
                      onChange={event => setFilter(event.target.value)}
                      placeholder="Find a page"
                      aria-label="Find a page"
                      className="h-8 pl-8 text-sm"
                    />
                  </div>
                </div>

                {filter.trim() ? (
                  filterMatches.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-muted-foreground">
                      No page matches “{filter.trim()}”.
                    </p>
                  ) : (
                    <div>
                      <p className="px-4 pt-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {filterMatches.length} match
                        {filterMatches.length === 1 ? "" : "es"}
                      </p>
                      <SidebarMenu className="px-2 py-1">
                        {filterMatches.map(({ item, groupLabel }) => {
                          const isActive = location === item.path;
                          return (
                            <SidebarMenuItem key={item.path}>
                              <SidebarMenuButton
                                isActive={isActive}
                                onClick={() => navigate(item.path)}
                                className="h-9 font-normal"
                              >
                                <NavIcon path={item.path} isActive={isActive} />
                                <span className="truncate">{item.label}</span>
                                <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground truncate">
                                  {groupLabel}
                                </span>
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          );
                        })}
                      </SidebarMenu>
                    </div>
                  )
                ) : (
                  navGroups.map(group =>
                    group.pinned ? (
                      <div key={group.id}>{renderItems(group.items)}</div>
                    ) : (
                      <Collapsible
                        key={group.id}
                        open={openGroups.includes(group.id)}
                        onOpenChange={open =>
                          setOpenGroups(previous =>
                            open
                              ? [...previous, group.id]
                              : previous.filter(id => id !== group.id)
                          )
                        }
                      >
                        <CollapsibleTrigger className="group/nav flex w-full items-center gap-2 px-4 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md">
                          <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]/nav:rotate-90" />
                          <span className="truncate">{group.label}</span>
                          <span className="ml-auto text-[10px] font-normal normal-case text-muted-foreground/70">
                            {group.items.length}
                          </span>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          {renderItems(group.items)}
                        </CollapsibleContent>
                      </Collapsible>
                    )
                  )
                )}
              </>
            )}
          </SidebarContent>

          <SidebarFooter className="p-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-3 rounded-lg px-1 py-1 hover:bg-accent/50 transition-colors w-full text-left group-data-[collapsible=icon]:justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Avatar className="h-9 w-9 border shrink-0">
                    <AvatarFallback className="text-xs font-medium">
                      {user?.name?.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                    <p className="text-sm font-medium truncate leading-none">
                      {user?.name || "-"}
                    </p>
                    <p className="text-xs text-muted-foreground truncate mt-1.5">
                      {user?.email || "-"}
                    </p>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>
        <div
          className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/20 transition-colors ${isCollapsed ? "hidden" : ""}`}
          onMouseDown={() => {
            if (isCollapsed) return;
            setIsResizing(true);
          }}
          style={{ zIndex: 50 }}
        />
      </div>

      <SidebarInset>
        {isMobile && (
          <div className="flex border-b h-14 items-center justify-between bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:backdrop-blur sticky top-0 z-40">
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-3">
                <SidebarTrigger className="h-9 w-9 rounded-lg bg-background" />
                <div className="flex items-center gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="tracking-tight text-foreground">
                      {activeMenuItem?.label ?? APP_TITLE}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <NotificationCenter />
              </div>
            </div>
          </div>
        )}
        <main className="flex-1 p-4">{children}</main>
      </SidebarInset>
    </>
  );
}
