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
 * The icons people give top concepts (`Concept.icon`), in picker order, with what each stands for. The names are the
 * preview's (`CONCEPT_ICONS` in `core/catalog.js`, drawn from its sprite), so either client draws what the other stored.
 */
export const CONCEPT_ICONS: readonly { name: string; label: string; icon: LucideIcon }[] = [
  { name: "layers", label: "Chung", icon: Layers },
  { name: "book", label: "Sách", icon: BookOpen },
  { name: "file-text", label: "Tài liệu", icon: FileText },
  { name: "graduation", label: "Học tập", icon: GraduationCap },
  { name: "lightbulb", label: "Ý tưởng", icon: Lightbulb },
  { name: "flask", label: "Khoa học", icon: FlaskConical },
  { name: "cpu", label: "Công nghệ", icon: Cpu },
  { name: "code", label: "Mã", icon: Code },
  { name: "network", label: "Mạng", icon: Network },
  { name: "database", label: "Dữ liệu", icon: Database },
  { name: "shield", label: "Bảo mật", icon: Shield },
  { name: "scale", label: "Pháp lý", icon: Scale },
  { name: "landmark", label: "Nhà nước", icon: Landmark },
  { name: "briefcase", label: "Kinh doanh", icon: Briefcase },
  { name: "banknote", label: "Tiền", icon: Banknote },
  { name: "wallet", label: "Thanh toán", icon: Wallet },
  { name: "chart", label: "Phân tích", icon: ChartColumn },
  { name: "target", label: "Mục tiêu", icon: Target },
  { name: "users", label: "Nhóm", icon: Users },
  { name: "heart", label: "Sức khỏe", icon: Heart },
  { name: "leaf", label: "Môi trường", icon: Leaf },
  { name: "globe", label: "Toàn cầu", icon: Globe },
  { name: "building", label: "Tổ chức", icon: Building2 },
  { name: "palette", label: "Thiết kế", icon: Palette },
  { name: "megaphone", label: "Tiếp thị", icon: Megaphone },
  { name: "calendar", label: "Sự kiện", icon: Calendar },
  { name: "settings", label: "Vận hành", icon: Settings },
  { name: "compass", label: "Chiến lược", icon: Compass },
  { name: "truck", label: "Hậu cần", icon: Truck },
  { name: "tag", label: "Thẻ", icon: Tag },
];

const ICONS: ReadonlyMap<string, LucideIcon> = new Map(CONCEPT_ICONS.map((i) => [i.name, i.icon]));

/** The icon for a stored icon name (a concept's, or a scheme's from `schemeIconName`); `fallback` (a tag by default) when
 *  there is none or it names one we don't draw. */
export const conceptIcon = (name: string | undefined, fallback: LucideIcon = Tag): LucideIcon => (name && ICONS.get(name)) || fallback;
