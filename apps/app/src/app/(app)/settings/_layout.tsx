import { Stack } from 'expo-router/stack'

export default function SettingsLayout() {
  return (
    <Stack screenOptions={{ headerShown: true, headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ title: 'Settings' }} />
      <Stack.Screen name="workspace" options={{ title: 'Workspace' }} />
      <Stack.Screen name="team" options={{ title: 'Team' }} />
      <Stack.Screen name="mailboxes" options={{ title: 'Mailboxes' }} />
      <Stack.Screen name="agents" options={{ title: 'Agents' }} />
      <Stack.Screen name="agents/[id]" options={{ title: 'Agent' }} />
      <Stack.Screen name="knowledge" options={{ title: 'Knowledge' }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
    </Stack>
  )
}
