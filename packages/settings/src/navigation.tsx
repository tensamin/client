import {
  Accessibility,
  Box,
  CodeXml,
  Keyboard,
  MessageSquare,
  Palette,
  Phone,
  Scale,
  Shield,
  Server,
  User,
} from "lucide-react";

export const settingsNavigation = [
  { category: null, path: "iota", label: "Iota", icon: <Server /> },
  {
    category: "account",
    path: "profile",
    label: "Profile",
    icon: <User />,
  },
  {
    category: "account",
    path: "security",
    label: "Security",
    icon: <Shield />,
  },
  { category: "general", path: "chat", label: "Chat", icon: <MessageSquare /> },
  { category: "general", path: "call", label: "Call", icon: <Phone /> },
  { category: "application", path: "cache", label: "Cache", icon: <Box /> },
  { category: "application", path: "theme", label: "Theme", icon: <Palette /> },
  {
    category: "application",
    path: "accessibility",
    label: "Accessibility",
    icon: <Accessibility />,
  },
  {
    category: "application",
    path: "hotkeys",
    label: "Hotkeys",
    icon: <Keyboard />,
  },
  ...(Number(localStorage.getItem("log_level")) >= 1000
    ? ([
        {
          category: "application",
          path: "developer",
          label: "Developer",
          icon: <CodeXml />,
        },
      ] as const)
    : []),
  {
    category: "application",
    path: "legal",
    label: "Legal",
    icon: <Scale />,
  },
] as const;
