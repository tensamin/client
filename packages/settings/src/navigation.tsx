import {
  Activity,
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
  {
    category: "application",
    path: "legal",
    label: "Legal",
    icon: <Scale />,
  },
  {
    category: "advanced",
    path: "diagnostics",
    label: "Diagnostics",
    icon: <Activity />,
  },
  { category: "advanced", path: "cache", label: "Cache", icon: <Box /> },
  ...(Number(localStorage.getItem("log_level")) >= 1000
    ? ([
        {
          category: "advanced",
          path: "developer",
          label: "Developer",
          icon: <CodeXml />,
        },
      ] as const)
    : []),
] as const;
