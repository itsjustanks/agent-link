import type { PluginTheme } from "@getpaseo/plugin";
import React, { createContext, useContext, useMemo, useState } from "react";
import { ActivityIndicator, Clipboard, Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";

/**
 * The plugin's design system.
 *
 * Paseo hands a surface six colours and a compact flag, and that is the whole
 * budget: no icon set inside a surface body, no SVG, no chart library. So
 * hierarchy has to come from type weight, surface level and spacing, and every
 * other colour is derived here rather than invented at each call site.
 *
 * Two rules keep it honest:
 *   - one filled button per view; everything else is quieter than it,
 *   - nothing non-interactive gets a border, so a border means "you can press".
 */

// ------------------------------------------------------------------- colour

function parse(color: string): [number, number, number, number] | null {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim());
  if (hex) {
    const value = hex[1]!;
    const expand = (part: string) => parseInt(part.length === 1 ? part + part : part, 16);
    if (value.length === 3 || value.length === 4) {
      return [expand(value[0]!), expand(value[1]!), expand(value[2]!), value.length === 4 ? expand(value[3]!) / 255 : 1];
    }
    if (value.length === 6 || value.length === 8) {
      return [
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16),
        value.length === 8 ? parseInt(value.slice(6, 8), 16) / 255 : 1,
      ];
    }
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (rgb) {
    const parts = rgb[1]!.split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((part) => Number.isFinite(part))) {
      return [parts[0]!, parts[1]!, parts[2]!, Number.isFinite(parts[3]!) ? parts[3]! : 1];
    }
  }
  return null;
}

/**
 * Translucent version of a colour. A colour this cannot parse is returned
 * unchanged on purpose: a solid border is a cosmetic flaw, and the string
 * concatenation this replaces produced an invisible one.
 */
export function alpha(color: string, amount: number): string {
  const parsed = parse(color);
  if (!parsed) return color;
  const [r, g, b, a] = parsed;
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.max(0, Math.min(1, a * amount))})`;
}

export function mix(base: string, over: string, amount: number): string {
  const one = parse(base);
  const two = parse(over);
  if (!one || !two) return base;
  const blend = (a: number, b: number) => Math.round(a + (b - a) * Math.max(0, Math.min(1, amount)));
  return `rgb(${blend(one[0], two[0])}, ${blend(one[1], two[1])}, ${blend(one[2], two[2])})`;
}

export function isDarkSurface(color: string): boolean {
  const parsed = parse(color);
  if (!parsed) return false;
  const [r, g, b] = parsed;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

// Paseo's palette has danger but no success or warning, so exactly two pairs are
// hardcoded — picked per light/dark surface. Nothing else in this file is a
// literal colour.
const SUCCESS = { dark: "#3ecf8e", light: "#12855a" };
const WARNING = { dark: "#e0a33e", light: "#a16207" };

// -------------------------------------------------------------------- tokens

export type Tokens = ReturnType<typeof tokens>;

export function tokens(theme: PluginTheme, compact: boolean) {
  const dark = isDarkSurface(theme.colors.surface0);
  const ink = dark ? "#ffffff" : "#000000";
  const fg = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const accent = theme.colors.accent;
  const danger = theme.colors.statusDanger;
  const success = dark ? SUCCESS.dark : SUCCESS.light;
  const warning = dark ? WARNING.dark : WARNING.light;

  return {
    compact,
    dark,
    color: {
      fg,
      muted,
      accent,
      accentFg: theme.colors.accentForeground,
      danger,
      success,
      warning,
      // Three surface levels. Never nest one inside another of the same level.
      surface0: theme.colors.surface0,
      surface1: mix(theme.colors.surface0, ink, dark ? 0.05 : 0.03),
      surface2: mix(theme.colors.surface0, ink, dark ? 0.09 : 0.06),
      borderSubtle: alpha(muted, 0.14),
      border: alpha(muted, 0.24),
      borderStrong: alpha(muted, 0.4),
      accentWash: alpha(accent, 0.14),
      accentLine: alpha(accent, 0.45),
      dangerWash: alpha(danger, 0.14),
      dangerLine: alpha(danger, 0.45),
      successWash: alpha(success, 0.14),
      warningWash: alpha(warning, 0.14),
      disabled: alpha(fg, 0.38),
      // Placeholder text is load-bearing (often the field's only label), so it
      // sits above the disabled tint contrast-wise without shouting.
      placeholder: alpha(fg, 0.5),
    },
    // Compact means narrow, not cramped: type grows a point and padding grows,
    // because a phone is held further from nobody's face than a monitor.
    text: {
      display: { fontSize: 20, fontWeight: "700" as const, lineHeight: 26, color: fg },
      heading: { fontSize: 15, fontWeight: "600" as const, lineHeight: 20, color: fg },
      body: { fontSize: compact ? 14 : 13, fontWeight: "400" as const, lineHeight: compact ? 20 : 18, color: fg },
      bodyStrong: { fontSize: compact ? 14 : 13, fontWeight: "600" as const, lineHeight: compact ? 20 : 18, color: fg },
      label: { fontSize: 12, fontWeight: "500" as const, lineHeight: 16, color: muted },
      caption: { fontSize: compact ? 12 : 11, fontWeight: "400" as const, lineHeight: 16, color: muted },
      mono: {
        fontSize: compact ? 12 : 11,
        lineHeight: 17,
        color: muted,
        fontFamily: compact ? "monospace" : "Menlo",
      },
    },
    space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, indent: 18 },
    radius: { sm: 6, md: 10, pill: 999 },
    control: { min: compact ? 40 : 28, hit: { top: 6, bottom: 6, left: 6, right: 6 } },
    maxWidth: 1100,
  };
}

const TokensContext = createContext<Tokens | null>(null);

export function TokensProvider({ value, children }: { value: Tokens; children: React.ReactNode }) {
  return <TokensContext.Provider value={value}>{children}</TokensContext.Provider>;
}

export function useTokens(): Tokens {
  const value = useContext(TokensContext);
  if (!value) throw new Error("useTokens must be used inside a Screen");
  return value;
}

export function useUi(theme: PluginTheme, compact: boolean): Tokens {
  return useMemo(() => tokens(theme, compact), [theme, compact]);
}

// ---------------------------------------------------------------- status map

export type Status = "ok" | "attention" | "error" | "neutral" | "busy";

export function statusColor(t: Tokens, status: Status): string {
  if (status === "ok") return t.color.success;
  if (status === "attention") return t.color.warning;
  if (status === "error") return t.color.danger;
  if (status === "busy") return t.color.accent;
  return t.color.muted;
}

// ----------------------------------------------------------------- structure

export function Screen({
  t,
  children,
  scroll = true,
}: {
  t: Tokens;
  children: React.ReactNode;
  scroll?: boolean;
}) {
  const body = (
    <View style={{ maxWidth: t.maxWidth, width: "100%", alignSelf: "center", gap: t.space.lg }}>{children}</View>
  );
  return (
    <TokensProvider value={t}>
      {scroll ? (
        <ScrollView
          style={{ flex: 1, backgroundColor: t.color.surface0 }}
          contentContainerStyle={{ padding: t.compact ? 16 : 20, paddingBottom: 48 }}
        >
          {body}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, backgroundColor: t.color.surface0, padding: t.compact ? 16 : 20 }}>{body}</View>
      )}
    </TokensProvider>
  );
}

/** Title, one sentence of orientation, and the actions for the whole surface. */
export function Toolbar({
  title,
  subtitle,
  actions,
  below,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  below?: React.ReactNode;
}) {
  const t = useTokens();
  return (
    <View style={{ gap: t.space.md }}>
      <View
        style={{
          flexDirection: t.compact ? "column" : "row",
          alignItems: t.compact ? "stretch" : "flex-end",
          justifyContent: "space-between",
          gap: t.space.md,
        }}
      >
        <View style={{ gap: 2, flexShrink: 1 }}>
          <Text style={t.text.display}>{title}</Text>
          {subtitle ? <Text style={t.text.caption}>{subtitle}</Text> : null}
        </View>
        {actions ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm, flexShrink: 1 }}>{actions}</View> : null}
      </View>
      {below}
    </View>
  );
}

export function Section({ title, trailing, children }: { title?: string; trailing?: React.ReactNode; children: React.ReactNode }) {
  const t = useTokens();
  return (
    <View style={{ gap: t.space.sm }}>
      {title ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
          <Text style={t.text.label}>{title.toUpperCase()}</Text>
          {trailing}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function Card({
  children,
  level = 1,
  padded = true,
  tone,
}: {
  children: React.ReactNode;
  level?: 1 | 2;
  padded?: boolean;
  tone?: Status;
}) {
  const t = useTokens();
  return (
    <View
      style={{
        backgroundColor: level === 1 ? t.color.surface1 : t.color.surface2,
        borderRadius: t.radius.md,
        borderWidth: 1,
        borderColor: tone ? alpha(statusColor(t, tone), 0.35) : t.color.borderSubtle,
        padding: padded ? (t.compact ? t.space.md : t.space.lg) : 0,
        gap: t.space.md,
        overflow: "hidden",
      }}
    >
      {children}
    </View>
  );
}

/**
 * One line of a list. Slotted rather than positional, and deliberately without
 * flexWrap: a wrapping row is what pushes an action button off screen the
 * moment an account email gets long.
 */
export function Row({
  leading,
  title,
  subtitle,
  meta,
  trailing,
  expanded,
  onPress,
  tone,
  selected,
  first,
}: {
  leading?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  meta?: React.ReactNode;
  trailing?: React.ReactNode;
  expanded?: React.ReactNode;
  onPress?: () => void;
  tone?: Status;
  selected?: boolean;
  first?: boolean;
}) {
  const t = useTokens();
  const body = (
    <View style={{ gap: t.space.sm }}>
      <View style={{ flexDirection: t.compact ? "column" : "row", alignItems: t.compact ? "stretch" : "center", gap: t.space.sm }}>
        {leading ? <View style={{ flexShrink: 0 }}>{leading}</View> : null}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          {typeof title === "string" ? (
            <Text numberOfLines={1} style={t.text.bodyStrong}>
              {title}
            </Text>
          ) : (
            title
          )}
          {typeof subtitle === "string" ? (
            <Text numberOfLines={1} style={t.text.caption}>
              {subtitle}
            </Text>
          ) : (
            subtitle
          )}
          {meta}
        </View>
        {trailing ? (
          <View
            style={{
              flexDirection: "row",
              gap: t.space.sm,
              flexShrink: 0,
              justifyContent: t.compact ? "flex-start" : "flex-end",
            }}
          >
            {trailing}
          </View>
        ) : null}
      </View>
      {expanded}
    </View>
  );

  const style = {
    paddingVertical: t.compact ? t.space.md : t.space.sm + 2,
    paddingHorizontal: t.space.md,
    borderTopWidth: first ? 0 : 1,
    borderTopColor: t.color.borderSubtle,
    borderLeftWidth: tone ? 2 : 0,
    borderLeftColor: tone ? statusColor(t, tone) : "transparent",
    backgroundColor: selected ? t.color.accentWash : "transparent",
  };

  if (!onPress) return <View style={style}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={onPress}
      style={({ pressed }) => [style, pressed ? { backgroundColor: alpha(t.color.muted, 0.1) } : null]}
    >
      {body}
    </Pressable>
  );
}

/** Up to three short facts, dot-separated — replaces long grey sentences. */
export function Facts({ items }: { items: Array<{ value: string; tone?: Status } | null | undefined> }) {
  const t = useTokens();
  const list = items.filter(Boolean) as Array<{ value: string; tone?: Status }>;
  if (list.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      {list.map((item, index) => (
        <React.Fragment key={`${item.value}-${index}`}>
          {index > 0 ? <Text style={[t.text.caption, { opacity: 0.5 }]}>·</Text> : null}
          <Text style={[t.text.caption, item.tone ? { color: statusColor(t, item.tone) } : null]}>{item.value}</Text>
        </React.Fragment>
      ))}
    </View>
  );
}

// ------------------------------------------------------------------- atoms

/** A dot and a word, always both — colour is never the only channel. */
export function StatusPill({ status, label }: { status: Status; label: string }) {
  const t = useTokens();
  const color = statusColor(t, status);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={[t.text.caption, { color, fontWeight: "600" }]}>{label}</Text>
    </View>
  );
}

export function Tag({ label, tone }: { label: string; tone?: Status }) {
  const t = useTokens();
  const color = tone ? statusColor(t, tone) : t.color.muted;
  return (
    <View
      style={{
        backgroundColor: tone ? alpha(color, 0.16) : t.color.surface2,
        borderRadius: t.radius.sm,
        paddingVertical: 2,
        paddingHorizontal: 7,
      }}
    >
      <Text style={{ fontSize: 11, lineHeight: 15, fontWeight: "600", color }}>{label}</Text>
    </View>
  );
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  label,
  onPress,
  variant = "secondary",
  disabled,
  loading,
  grow,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  grow?: boolean;
}) {
  const t = useTokens();
  const off = Boolean(disabled) || Boolean(loading);
  const palette = {
    primary: { bg: t.color.accent, border: t.color.accent, fg: t.color.accentFg },
    secondary: { bg: t.color.surface2, border: t.color.border, fg: t.color.fg },
    ghost: { bg: "transparent", border: "transparent", fg: t.color.accent },
    danger: { bg: t.color.dangerWash, border: t.color.dangerLine, fg: t.color.danger },
  }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy: Boolean(loading) }}
      onPress={onPress}
      disabled={off}
      hitSlop={t.control.hit}
      style={({ pressed }) => ({
        flexGrow: grow ? 1 : 0,
        minHeight: t.control.min,
        paddingHorizontal: variant === "ghost" ? 8 : 12,
        borderRadius: t.radius.sm,
        borderWidth: 1,
        borderColor: off && variant !== "ghost" ? t.color.borderSubtle : palette.border,
        backgroundColor: off && variant === "primary" ? alpha(t.color.accent, 0.25) : palette.bg,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: 6,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {loading ? <ActivityIndicator size="small" color={off ? t.color.disabled : palette.fg} /> : null}
      <Text style={{ fontSize: t.compact ? 13 : 12, fontWeight: "600", color: off ? t.color.disabled : palette.fg }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A destructive action asks once, in place, rather than through a dialog. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  variant = "danger",
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  variant?: ButtonVariant;
}) {
  const t = useTokens();
  const [armed, setArmed] = useState(false);
  if (!armed) return <Button label={label} variant={variant} onPress={() => setArmed(true)} />;
  return (
    <View style={{ flexDirection: "row", gap: t.space.sm }}>
      <Button
        label={confirmLabel}
        variant="danger"
        onPress={() => {
          setArmed(false);
          onConfirm();
        }}
      />
      <Button label="Cancel" variant="ghost" onPress={() => setArmed(false)} />
    </View>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const t = useTokens();
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: t.color.surface2,
        borderRadius: t.radius.sm,
        padding: 2,
        alignSelf: "flex-start",
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active, disabled: Boolean(option.disabled) }}
            disabled={option.disabled}
            onPress={() => onChange(option.value)}
            hitSlop={t.control.hit}
            style={{
              paddingVertical: t.compact ? 8 : 5,
              paddingHorizontal: 12,
              minHeight: t.control.min,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: t.radius.sm - 2,
              backgroundColor: active ? t.color.surface0 : "transparent",
            }}
          >
            <Text
              style={{
                fontSize: t.compact ? 13 : 12,
                fontWeight: "600",
                color: option.disabled ? t.color.disabled : active ? t.color.fg : t.color.muted,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  multiline,
  mono,
  minHeight,
  autoFocus,
  hint,
}: {
  label?: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
  minHeight?: number;
  autoFocus?: boolean;
  hint?: string;
}) {
  const t = useTokens();
  return (
    <View style={{ gap: 4 }}>
      {label ? <Text style={t.text.label}>{label}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.color.placeholder}
        accessibilityLabel={label ?? placeholder}
        multiline={multiline}
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        style={{
          borderWidth: 1,
          borderColor: t.color.border,
          borderRadius: t.radius.sm,
          backgroundColor: t.color.surface0,
          paddingVertical: t.compact ? 10 : 7,
          paddingHorizontal: 10,
          color: t.color.fg,
          minHeight: minHeight ?? (multiline ? 120 : t.control.min),
          textAlignVertical: multiline ? "top" : "center",
          ...(mono ? { fontFamily: t.compact ? "monospace" : "Menlo", fontSize: t.compact ? 12 : 11.5 } : { fontSize: t.compact ? 14 : 13 }),
        }}
      />
      {hint ? <Text style={t.text.caption}>{hint}</Text> : null}
    </View>
  );
}

/**
 * No RPC copies arbitrary text, so this goes through the host's clipboard —
 * which a host is free not to have. The caller says so rather than pretending
 * the copy happened; the text stays selectable either way.
 */
export function copyToClipboard(text: string): boolean {
  try {
    Clipboard.setString(text);
    return true;
  } catch {
    return false;
  }
}

export function CodeBlock({ children, tone, copy = true }: { children: string; tone?: Status; copy?: boolean }) {
  const t = useTokens();
  const [copied, setCopied] = useState(false);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: t.space.sm,
        backgroundColor: t.color.surface2,
        borderRadius: t.radius.sm,
        borderLeftWidth: tone ? 2 : 0,
        borderLeftColor: tone ? statusColor(t, tone) : "transparent",
        padding: t.space.sm,
      }}
    >
      <Text selectable style={[t.text.mono, { flex: 1, minWidth: 0 }]}>
        {children}
      </Text>
      {copy ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? "Copied to clipboard" : "Copy to clipboard"}
          hitSlop={t.control.hit}
          onPress={() => {
            if (!copyToClipboard(children)) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          <Text style={[t.text.caption, { fontWeight: "600", color: copied ? t.color.success : t.color.accent }]}>
            {copied ? "Copied" : "Copy"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Notice({
  tone = "neutral",
  children,
  onDismiss,
}: {
  tone?: Status;
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  const t = useTokens();
  const color = statusColor(t, tone);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: t.space.sm,
        backgroundColor: alpha(color, 0.12),
        borderRadius: t.radius.sm,
        borderLeftWidth: 2,
        borderLeftColor: color,
        paddingVertical: t.space.sm,
        paddingHorizontal: t.space.md,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        {typeof children === "string" ? <Text style={t.text.body}>{children}</Text> : children}
      </View>
      {onDismiss ? <Button label="Dismiss" variant="ghost" onPress={onDismiss} /> : null}
    </View>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  const t = useTokens();
  return (
    <View style={{ padding: t.space.xl, gap: t.space.sm, alignItems: "flex-start" }}>
      <Text style={t.text.heading}>{title}</Text>
      <Text style={[t.text.body, { color: t.color.muted, maxWidth: 520 }]}>{body}</Text>
      {action ? <View style={{ paddingTop: t.space.sm }}>{action}</View> : null}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, padding: t.space.md }}>
      <ActivityIndicator size="small" color={t.color.accent} />
      {label ? <Text style={t.text.caption}>{label}</Text> : null}
    </View>
  );
}

export function ErrorText({ children }: { children: string }) {
  const t = useTokens();
  return <Text style={[t.text.caption, { color: t.color.danger }]}>{children}</Text>;
}

export function Disclosure({ title, children, open: initial = false }: { title: string; children: React.ReactNode; open?: boolean }) {
  const t = useTokens();
  const [open, setOpen] = useState(initial);
  return (
    <View style={{ gap: t.space.sm }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        hitSlop={t.control.hit}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: t.control.min, justifyContent: "flex-start" }}
      >
        <Text style={{ fontSize: 11, color: t.color.muted }}>{open ? "▾" : "▸"}</Text>
        <Text style={[t.text.caption, { fontWeight: "600" }]}>{title}</Text>
      </Pressable>
      {open ? <View style={{ gap: t.space.sm, paddingLeft: t.space.indent }}>{children}</View> : null}
    </View>
  );
}

/** "3 of 7 destinations" as a bar plus its number — never a bare bar. */
export function Coverage({ present, total, label }: { present: number; total: number; label?: string }) {
  const t = useTokens();
  const fraction = total > 0 ? present / total : 0;
  const status: Status = fraction === 1 ? "ok" : fraction === 0 ? "neutral" : "attention";
  return (
    <View style={{ gap: 4, minWidth: 120, flexGrow: 1 }}>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: alpha(t.color.muted, 0.2), overflow: "hidden" }}>
        <View style={{ width: `${Math.round(fraction * 100)}%`, height: "100%", backgroundColor: statusColor(t, status) }} />
      </View>
      <Text style={t.text.caption}>{label ?? `${present} of ${total}`}</Text>
    </View>
  );
}

export function Meter({ fraction, label, tone = "neutral" }: { fraction: number; label: string; tone?: Status }) {
  const t = useTokens();
  const value = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return (
    <View style={{ gap: 4, flexGrow: 1, minWidth: 120 }}>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: alpha(t.color.muted, 0.2), overflow: "hidden" }}>
        <View style={{ width: `${Math.round(value * 100)}%`, height: "100%", backgroundColor: statusColor(t, tone) }} />
      </View>
      <Text style={t.text.caption}>{label}</Text>
    </View>
  );
}

export function Spark({ values, tone = "neutral" }: { values: number[]; tone?: Status }) {
  const t = useTokens();
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
            backgroundColor: value > 0 ? statusColor(t, tone) : alpha(t.color.muted, 0.25),
          }}
        />
      ))}
    </View>
  );
}

/**
 * The preview stage: a rendered artifact, sized from its own aspect ratio and
 * whatever width the pane happens to have.
 */
export function Figure({
  uri,
  width,
  height,
  label,
  loading,
  note,
  placeholder,
}: {
  uri?: string;
  width?: number;
  height?: number;
  label: string;
  loading?: boolean;
  note?: string;
  placeholder?: React.ReactNode;
}) {
  const t = useTokens();
  const [stage, setStage] = useState(0);
  const aspect = width && height && width > 0 ? height / width : 0.62;
  const drawWidth = stage > 0 ? stage : 320;
  return (
    <View style={{ gap: t.space.sm }} onLayout={(event) => setStage(event.nativeEvent.layout.width)}>
      <View
        style={{
          borderRadius: t.radius.md,
          borderWidth: 1,
          borderColor: t.color.borderSubtle,
          backgroundColor: t.color.surface1,
          overflow: "hidden",
          minHeight: 160,
          justifyContent: "center",
        }}
      >
        {uri ? (
          <Image
            accessibilityLabel={label}
            source={{ uri }}
            resizeMode="contain"
            style={{ width: drawWidth, height: Math.max(160, Math.round(drawWidth * aspect)) }}
          />
        ) : loading ? (
          <Loading label="Rendering…" />
        ) : (
          placeholder ?? null
        )}
      </View>
      {note ? <Text style={t.text.caption}>{note}</Text> : null}
    </View>
  );
}

/** List beside detail on a wide screen; one at a time on a phone. */
export function SplitView({
  list,
  detail,
  showDetail,
  listWidth = 320,
}: {
  list: React.ReactNode;
  detail: React.ReactNode;
  showDetail: boolean;
  listWidth?: number;
}) {
  const t = useTokens();
  if (t.compact) return <View style={{ flex: 1 }}>{showDetail ? detail : list}</View>;
  return (
    <View style={{ flexDirection: "row", gap: t.space.lg, alignItems: "flex-start" }}>
      {/* ponytail: fixed cap — a long list must not scroll the detail away;
          go viewport-relative via useWindowDimensions if 640 ever feels wrong */}
      <ScrollView style={{ width: listWidth, flexShrink: 0, maxHeight: 640 }}>{list}</ScrollView>
      <View style={{ flex: 1, minWidth: 0 }}>{detail}</View>
    </View>
  );
}
