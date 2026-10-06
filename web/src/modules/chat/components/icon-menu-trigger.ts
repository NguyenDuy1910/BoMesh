import { buttonClasses } from "@/components/ui/Button";

/** Menu's default trigger is an outlined button; icon menus in chat are ghost icon buttons. */
export const ICON_MENU_TRIGGER = buttonClasses({ variant: "ghost", size: "sm", iconOnly: true, className: "bg-transparent shadow-none" });
