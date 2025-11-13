# Roku Feed Mobile App

A React Native iOS app built with Expo for streaming sports content.

## Setup

### Install Dependencies

First, update React to fix version conflicts:

```bash
npm install react@19.2.0 react-dom@19.2.0
```

Then install the remaining dependencies:

```bash
npm install expo-video fuse.js
```

After installing packages, rebuild the app to apply native changes:

```bash
npx expo prebuild --clean
npx expo run:ios
```

Or if using development build:

```bash
npx expo start --clear
```

### Development

```bash
npm start
```

Then press `i` to open in iOS simulator, or scan the QR code with the Expo Go app on your device.

## Tech Stack

- Expo SDK 52
- Expo Router (file-based navigation)
- NativeWind v4 (Tailwind CSS for React Native)
- TypeScript

