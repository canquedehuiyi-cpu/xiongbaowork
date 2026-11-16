import type { ExpoConfig } from "expo/config";

const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
const config: ExpoConfig = {
  name: "熊宝",
  slug: "xiongbao",
  version: "0.0.1",
  scheme: "xiongbao",
  ios: { bundleIdentifier: "com.xiongbao.mobile", supportsTablet: true },
  android: { package: "com.xiongbao.mobile" },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-notifications", { defaultChannel: "xiongbao" }],
  ],
  extra: { ...(projectId ? { eas: { projectId } } : {}) },
};
export default config;
