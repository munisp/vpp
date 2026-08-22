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
import { APP_LOGO, APP_TITLE, getLoginUrl } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import { 
  LayoutDashboard, 
  LogOut, 
  PanelLeft, 
  Zap, 
  Activity, 
  TrendingUp, 
  Receipt, 
  CreditCard,
  Bell,
  Settings,
  Shield,
  BarChart3,
  Sparkles,
  Sun,
  BatteryCharging,
  Leaf,
  ArrowDownUp,
  Wallet as WalletIcon,
  CalendarClock,
  AlertTriangle,
  CloudSun,
  SlidersHorizontal,
  Target,
  ShieldAlert,
  FileCheck,
  Users,
  MessageSquare,
  Globe,
  Coins,
  MapPin
} from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from './DashboardLayoutSkeleton';
import { Button } from "./ui/button";
import { NotificationCenter } from './NotificationCenter';
import { QrCode, Gift, History } from 'lucide-react';

type MenuItem = { icon: any; label: string; path: string };
type MenuSection = { label?: string; items: MenuItem[] };

const getMenuSections = (userRole?: string): MenuSection[] => [
  {
    items: [
      { icon: LayoutDashboard, label: "Dashboard", path: "/" },
      { icon: Zap, label: "My Assets", path: "/assets" },
      { icon: Activity, label: "Monitoring", path: "/monitoring" },
      { icon: TrendingUp, label: "Trading", path: "/trading" },
      { icon: Zap, label: "Energy Insights", path: "/energy-insights" },
      { icon: Receipt, label: "Billing", path: "/billing" },
      { icon: CreditCard, label: "Payments", path: "/payments" },
      { icon: Bell, label: "Alerts", path: "/alerts" },
      { icon: BarChart3, label: "Analytics", path: "/analytics" },
      { icon: Zap, label: "Demand Response", path: "/demand-response" },
    ],
  },
  {
    label: "Insights",
    items: [
      { icon: BarChart3, label: "Energy Analytics", path: "/energy-analytics" },
      { icon: Sparkles, label: "Energy Advisor", path: "/insights/advisor" },
      { icon: Sun, label: "Solar Yield", path: "/insights/solar-yield" },
      { icon: BatteryCharging, label: "Battery Health", path: "/insights/battery-health" },
      { icon: Leaf, label: "Carbon Credits", path: "/insights/carbon" },
    ],
  },
  {
    label: "Market",
    items: [
      { icon: TrendingUp, label: "Tariffs", path: "/market/tariffs" },
      { icon: ArrowDownUp, label: "Order Book", path: "/market/order-book" },
      { icon: Globe, label: "Price Alerts", path: "/trading/price-alerts" },
    ],
  },
  {
    label: "Wallet & V2G",
    items: [
      { icon: WalletIcon, label: "Wallet", path: "/wallet" },
      { icon: CalendarClock, label: "V2G Optimizer", path: "/v2g" },
    ],
  },
  {
    label: "Grid Ops",
    items: [
      { icon: SlidersHorizontal, label: "Control Windows", path: "/grid/control-windows" },
      { icon: AlertTriangle, label: "Anomalies", path: "/grid/anomalies" },
      { icon: CloudSun, label: "DR Forecast", path: "/grid/dr-forecast" },
      { icon: Target, label: "Forecast Accuracy", path: "/grid/forecast-accuracy" },
      { icon: Coins, label: "Price Signals", path: "/grid/price-signals" },
      { icon: MapPin, label: "Locational Flexibility", path: "/grid/locational-flexibility" },
      ...(userRole === 'admin'
        ? [
            { icon: Activity, label: "Fleet Telemetry", path: "/grid/fleet-telemetry" },
            { icon: ShieldAlert, label: "NTL Detection", path: "/grid/ntl" },
            { icon: FileCheck, label: "Compliance Reports", path: "/grid/compliance-reports" },
          ]
        : []),
    ],
  },
  {
    label: "Community",
    items: [
      { icon: Users, label: "Community Pools", path: "/community-pools" },
      { icon: MessageSquare, label: "SMS Center", path: "/sms-center" },
    ],
  },
  {
    items: [
      { icon: QrCode, label: "QR Scanner", path: "/qr-scanner" },
      { icon: History, label: "QR History", path: "/qr-history" },
      { icon: Gift, label: "Referrals", path: "/referrals" },
      { icon: Settings, label: "Settings", path: "/settings" },
      ...(userRole === 'admin' ? [{ icon: Shield, label: "Admin", path: "/admin" }] : []),
    ],
  },
];

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
  const menuSections = getMenuSections(user?.role);
  const allMenuItems = menuSections.flatMap(s => s.items);
  const activeMenuItem = allMenuItems.find(item => item.path === location);
  const isMobile = useIsMobile();

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
            {menuSections.map((section, si) => (
              <div key={si}>
                {section.label && (
                  <p className="px-4 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground group-data-[collapsible=icon]:hidden">
                    {section.label}
                  </p>
                )}
                <SidebarMenu className="px-2 py-1">
                  {section.items.map(item => {
                    const isActive = location === item.path;
                    return (
                      <SidebarMenuItem key={item.path}>
                        <SidebarMenuButton
                          isActive={isActive}
                          onClick={() => setLocation(item.path)}
                          tooltip={item.label}
                          className={`h-10 transition-all font-normal`}
                        >
                          <item.icon
                            className={`h-4 w-4 ${isActive ? "text-primary" : ""}`}
                          />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </div>
            ))}
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
