import { Stack } from 'expo-router/stack'

export default function SettingsLayout() {
  return (
    <Stack screenOptions={{ headerShown: true, headerBackButtonDisplayMode: 'minimal' }}>
      <Stack.Screen name="index" options={{ title: 'Settings' }} />
      <Stack.Screen name="workspace" options={{ title: 'Workspace' }} />
      <Stack.Screen name="team" options={{ title: 'Team' }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
    </Stack>
  )
}
