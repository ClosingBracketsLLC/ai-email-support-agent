import { useRouter, usePathname } from 'expo-router'
import { Tabs } from 'expo-router/js-tabs'
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { Lockup } from './brand'
import { Icon, type IconName } from './icon'
import { WIDE_BREAKPOINT, font, radius, spacing, typeScale, useColors } from '@/theme'

interface TabDef { name: 'inbox' | 'activity' | 'settings'; title: string; icon: IconName; href: '/inbox' | '/activity' | '/settings' }
const TABS: TabDef[] = [
  { name: 'inbox', title: 'Inbox', icon: 'inbox', href: '/inbox' },
  { name: 'activity', title: 'Activity', icon: 'activity', href: '/activity' },
  { name: 'settings', title: 'Settings', icon: 'settings', href: '/settings' },
]

/**
 * One navigator, two compositions (spec, UX: native vs web): bottom tabs on phones, a sidebar with the tab bar
 * hidden on tablets-landscape and desktop. Must be rendered by app/(app)/_layout.tsx because it owns the <Tabs>.
 *
 * <Tabs> always sits at the same position in the returned tree, wrapped by the same ancestor <View>s, regardless
 * of `wide` — only the sidebar is conditionally rendered alongside it. React reconciles by element type at a
 * tree position, so if the wide and narrow branches nested <Tabs> under different ancestor types (as a version
 * of this component once did, returning bare <Tabs> when narrow but <View><View><Tabs/></View></View> when
 * wide), crossing WIDE_BREAKPOINT on a resize or rotation would unmount and remount the whole Tabs subtree,
 * resetting the active tab and its nested navigation state.
 */
export function ResponsiveShell() {
  const c = useColors()
  const { width } = useWindowDimensions()
  const wide = width >= WIDE_BREAKPOINT
  const pathname = usePathname()

  return (
    <View style={[styles.row, { backgroundColor: c.bg }]}>
      {wide ? <Sidebar pathname={pathname} /> : null}
      <View style={styles.main}>
        <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: c.primary, tabBarInactiveTintColor: c.muted, tabBarStyle: wide ? { display: 'none' } : { backgroundColor: c.bg, borderTopColor: c.border } }}>
          {TABS.map((t) => (
            <Tabs.Screen
              key={t.name}
              name={t.name}
              options={{
                title: t.title,
                tabBarButtonTestID: `tab-${t.name}`,
                tabBarIcon: ({ color }) => <Icon name={t.icon} size={22} color={color as string} />,
                // The outline/filled Ionicons pair used to be the second channel alongside colour
                // (WCAG 1.4.1) — this branch's SVG icons removed it (STATUS carry-over). A weight
                // cue on the label replaces it: primary vs muted are near-identical lightness.
                tabBarLabel: ({ focused, color, children }) => (
                  <Text style={[typeScale.caption, focused && { fontFamily: font.uiStrong }, { color }]}>{children}</Text>
                ),
              }}
            />
          ))}
          {/* The ticket thread is reached only from an inbox row or a push tap (router.push), never from
              a tab button — `href: null` keeps it out of the tab bar; `expo-router`'s `Tabs` otherwise
              auto-registers every file in this directory as a tab. Hidden here too, on phones, so the
              thread gets the full screen instead of a tab bar docked under it. */}
          <Tabs.Screen name="ticket/[id]" options={{ href: null, tabBarStyle: { display: 'none' } }} />
        </Tabs>
      </View>
    </View>
  )
}

function Sidebar({ pathname }: { pathname: string }) {
  const c = useColors()
  const router = useRouter()
  return (
    <View style={[styles.sidebar, { borderRightColor: c.border, backgroundColor: c.surface }]} accessibilityRole="menu">
      <View style={styles.brand}><Lockup height={24} /></View>
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`)
        return (
          // expo-router's `Link asChild` wrapping `Pressable` crashes on web ("Failed to set an indexed
          // property [0] on 'CSSStyleDeclaration'") the first time it mounts — router.push avoids it.
          <Pressable key={t.name} accessibilityRole="menuitem" testID={`nav-${t.name}`} onPress={() => router.push(t.href)} style={[styles.item, active && { backgroundColor: c.primaryTint }]}>
            <Icon name={t.icon} size={20} color={active ? c.primary : c.muted} />
            {/* `primary` text on `primaryTint` is 4.46 (STATUS deviation 6, large-text-only) — below AA at
                this 15 px body size. The active row uses `c.text` (14.78 on primaryTint) and carries the
                weight cue instead; the icon alone keeps `c.primary` when active. */}
            <Text style={[active ? typeScale.bodyStrong : typeScale.body, { color: c.text }]}>{t.title}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  sidebar: { width: 240, borderRightWidth: StyleSheet.hairlineWidth, padding: spacing.md, gap: spacing.xs },
  brand: { paddingVertical: spacing.md, paddingHorizontal: spacing.sm },
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.md },
  main: { flex: 1 },
})
