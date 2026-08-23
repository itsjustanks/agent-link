import type { PluginTheme } from "@getpaseo/plugin";
import React from "react";
import { Pressable, Text, View } from "react-native";

// Traffic-light status colors — fixed semantics across themes.
export const STATUS = {
  green: "#22c55e",
  orange: "#f59e0b",
  red: "#ef4444",
} as const;

export function makeStyles(theme: PluginTheme, compact: boolean) {
  // One spacing scale, tightened on narrow screens rather than reflowed ad hoc.
  const gap = compact ? 6 : 8;
  const pad = compact ? 12 : 20;
  const mono = compact ? "monospace" : "Menlo";
  const line = theme.colors.foregroundMuted + "1f";
  return {
    pad,
    gap,
    mono,
    compact,
    line,
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: {
      padding: pad,
      paddingBottom: pad * 2,
      gap: compact ? 10 : 14,
      maxWidth: 780,
      width: "100%" as const,
      alignSelf: "center" as const,
    },
    headerRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      flexWrap: "wrap" as const,
      gap,
    },
    title: { color: theme.colors.foreground, fontSize: compact ? 18 : 21, fontWeight: "700" as const },
    sectionTitle: { color: theme.colors.foreground, fontSize: compact ? 13 : 14, fontWeight: "700" as const },
    subtitle: { color: theme.colors.foregroundMuted, fontSize: compact ? 11 : 12, lineHeight: compact ? 16 : 18 },
    card: {
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted + "2e",
      borderRadius: compact ? 10 : 12,
      padding: compact ? 10 : 14,
      gap,
    },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap, flexWrap: "wrap" as const },
    rowBetween: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap,
      flexWrap: "wrap" as const,
    },
    text: { color: theme.colors.foreground, fontSize: compact ? 12 : 13 },
    strong: { color: theme.colors.foreground, fontSize: compact ? 12.5 : 13.5, fontWeight: "600" as const },
    muted: { color: theme.colors.foregroundMuted, fontSize: compact ? 11 : 12 },
    danger: { color: theme.colors.statusDanger, fontSize: compact ? 11 : 12 },
    monoText: { color: theme.colors.foregroundMuted, fontSize: compact ? 10 : 11, fontFamily: mono },
    banner: { padding: 10, borderRadius: 8, backgroundColor: theme.colors.accent },
    bannerText: { color: theme.colors.accentForeground, fontSize: compact ? 11 : 12 },
    input: {
      borderWidth: 1,
      borderColor: theme.colors.foregroundMuted + "44",
      borderRadius: 8,
      paddingVertical: compact ? 7 : 6,
      paddingHorizontal: 9,
      color: theme.colors.foreground,
      fontSize: compact ? 12 : 12.5,
      minHeight: compact ? 36 : 32, // comfortable tap target on touch
    },
    divider: { borderTopWidth: 1, borderTopColor: theme.colors.foregroundMuted + "1f" },
  };
}

export function Dot({ color }: { color: string }) {
  return <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />;
}

// Share-of-rotation meter. Deliberately not a quota gauge — see README.
export function Meter({ fraction, color, theme }: { fraction: number; color: string; theme: PluginTheme }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return (
    <View
      style={{
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.foregroundMuted + "33",
        overflow: "hidden",
        flexGrow: 1,
        minWidth: 60,
      }}
    >
      <View style={{ width: `${Math.round(pct * 100)}%`, height: "100%", backgroundColor: color }} />
    </View>
  );
}

// Tiny bar chart — daily activity at a glance without a chart library.
export function Spark({ values, color, theme }: { values: number[]; color: string; theme: PluginTheme }) {
  const max = Math.max(1, ...values);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height: 16 }}>
      {values.map((value, index) => (
        <View
          key={index}
          style={{
            width: 5,
            height: Math.max(2, Math.round((value / max) * 16)),
            borderRadius: 1,
            backgroundColor: value > 0 ? color : theme.colors.foregroundMuted + "33",
          }}
        />
      ))}
    </View>
  );
}

export function Badge({ label, theme, tone }: { label: string; theme: PluginTheme; tone?: "danger" | "accent" }) {
  const color =
    tone === "danger" ? theme.colors.statusDanger : tone === "accent" ? theme.colors.accent : theme.colors.foregroundMuted;
  return (
    <View style={{ borderWidth: 1, borderColor: color + "66", borderRadius: 999, paddingVertical: 2, paddingHorizontal: 8 }}>
      <Text style={{ color, fontSize: 10, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export function Btn({
  label,
  onPress,
  theme,
  kind = "primary",
  disabled,
  compact,
}: {
  label: string;
  onPress: () => void;
  theme: PluginTheme;
  kind?: "primary" | "quiet" | "danger";
  disabled?: boolean;
  compact?: boolean;
}) {
  const background = kind === "primary" ? theme.colors.accent : "transparent";
  const border =
    kind === "danger" ? theme.colors.statusDanger : kind === "quiet" ? theme.colors.foregroundMuted + "66" : theme.colors.accent;
  const color =
    kind === "primary" ? theme.colors.accentForeground : kind === "danger" ? theme.colors.statusDanger : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      style={{
        paddingVertical: compact ? 7 : 5,
        paddingHorizontal: compact ? 12 : 10,
        borderRadius: 8,
        backgroundColor: background,
        borderWidth: 1,
        borderColor: border,
        opacity: disabled ? 0.5 : 1,
        minHeight: compact ? 32 : 26, // touch target
        justifyContent: "center" as const,
      }}
    >
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}
