import {
  Banknote,
  BookOpen,
  Briefcase,
  Building2,
  Calendar,
  ChartColumn,
  Code,
  Compass,
  Cpu,
  Database,
  FileText,
  FlaskConical,
  Globe,
  GraduationCap,
  Heart,
  Landmark,
  Layers,
  Leaf,
  Lightbulb,
  Megaphone,
  Network,
  Palette,
  Scale,
  Settings,
  Shield,
  Tag,
  Target,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

/**
 * The icons people give domains and topics (`Topic.icon`), in picker order, with what each stands for. The names are
 * the preview's (`TOPIC_ICONS` in `core/catalog.js`, drawn from its sprite), so either client draws what the other stored.
 */
export const TOPIC_ICONS: readonly { name: string; label: string; icon: LucideIcon }[] = [
  { name: "layers", label: "General", icon: Layers },
  { name: "book", label: "Book", icon: BookOpen },
  { name: "file-text", label: "Documents", icon: FileText },
  { name: "graduation", label: "Learning", icon: GraduationCap },
  { name: "lightbulb", label: "Ideas", icon: Lightbulb },
  { name: "flask", label: "Science", icon: FlaskConical },
  { name: "cpu", label: "Technology", icon: Cpu },
  { name: "code", label: "Code", icon: Code },
  { name: "network", label: "Network", icon: Network },
  { name: "database", label: "Data", icon: Database },
  { name: "shield", label: "Security", icon: Shield },
  { name: "scale", label: "Legal", icon: Scale },
  { name: "landmark", label: "Government", icon: Landmark },
  { name: "briefcase", label: "Business", icon: Briefcase },
  { name: "banknote", label: "Money", icon: Banknote },
  { name: "wallet", label: "Payments", icon: Wallet },
  { name: "chart", label: "Analytics", icon: ChartColumn },
  { name: "target", label: "Goals", icon: Target },
  { name: "users", label: "Teams", icon: Users },
  { name: "heart", label: "Health", icon: Heart },
  { name: "leaf", label: "Environment", icon: Leaf },
  { name: "globe", label: "Global", icon: Globe },
  { name: "building", label: "Organization", icon: Building2 },
  { name: "palette", label: "Design", icon: Palette },
  { name: "megaphone", label: "Marketing", icon: Megaphone },
  { name: "calendar", label: "Events", icon: Calendar },
  { name: "settings", label: "Operations", icon: Settings },
  { name: "compass", label: "Strategy", icon: Compass },
  { name: "truck", label: "Logistics", icon: Truck },
  { name: "tag", label: "Tag", icon: Tag },
];

/** A new domain's icon; also what a domain without one shows. */
export const DOMAIN_ICON = "layers";

const ICONS: ReadonlyMap<string, LucideIcon> = new Map(TOPIC_ICONS.map((i) => [i.name, i.icon]));

/** The icon for a topic's stored icon name; `fallback` (a tag by default) when it has none or names one we don't draw. */
export const topicIcon = (name: string | undefined, fallback: LucideIcon = Tag): LucideIcon => (name && ICONS.get(name)) || fallback;
