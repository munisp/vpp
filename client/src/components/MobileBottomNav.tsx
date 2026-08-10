import { Home, Zap, TrendingUp, CreditCard, Settings } from "lucide-react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";

const navItems = [
  { icon: Home, label: "Home", path: "/" },
  { icon: Zap, label: "Assets", path: "/assets" },
  { icon: TrendingUp, label: "Trading", path: "/trading" },
  { icon: CreditCard, label: "Payments", path: "/payments" },
  { icon: Settings, label: "Settings", path: "/settings" },
];

export function MobileBottomNav() {
  const [location] = useLocation();

  // Only show on mobile devices
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  if (!isMobile) return null;

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-background border-t border-border">
      <div className="flex items-center justify-around h-16 px-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = location === item.path;

          return (
            <Link
              key={item.path}
              href={item.path}
              className={cn(
                "flex flex-col items-center justify-center flex-1 h-full gap-1 transition-colors",
                "active:bg-accent/50",
                isActive ? "text-primary" : "text-muted-foreground"
              )}
            >
              <Icon className={cn("h-5 w-5", isActive && "fill-current")} />
              <span className="text-xs font-medium">{item.label}</span>
            </Link>
          );
        })}
      </div>
      {/* Safe area for iOS devices */}
      <div className="h-[env(safe-area-inset-bottom)] bg-background" />
    </nav>
  );
}
