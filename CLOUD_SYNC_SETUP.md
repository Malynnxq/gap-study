# Cross-device sync setup

The branch `feature/cross-device-sync` contains the browser-side implementation. It needs a Supabase project before synchronization can actually connect.

## 1. Create the database table

In Supabase, open **SQL Editor**, paste the contents of `supabase/schema.sql`, and run it.

The included policies enable Row Level Security. Each signed-in user can access only the row whose `user_id` matches their own account.

## 2. Enable email sign-in

In **Authentication → Providers**, keep Email enabled. Magic-link / OTP sign-in is used by the site.

In **Authentication → URL Configuration**, add the Gap Study GitHub Pages address as an allowed redirect URL, for example:

```text
https://malynnxq.github.io/gap-study/
```

## 3. Add the public browser configuration

Open **Project Settings → API** and copy:

- Project URL
- public `anon` key

Put them into `cloud-config.js`:

```js
window.GAP_STUDY_CLOUD_CONFIG = {
  supabaseUrl: 'https://YOUR_PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR_PUBLIC_ANON_KEY'
};
```

The anon key is designed to be public. Do not put a service-role key into the repository. Access control depends on the Row Level Security policies in `supabase/schema.sql`.

Alternatively, while testing, the same two public values can be entered through the **Cloud sync** panel in the site. They will then be stored only in that browser.

## Behaviour

- The existing local browser save remains active and works offline.
- When signed in, local progress is synchronized to one cloud row per user.
- The site checks for updates from other devices approximately every seven seconds.
- If another device has newer progress while an answer field is active, the site shows a banner instead of abruptly reloading.
- Correct and revealed gaps are merged between devices when both devices changed the same exercise.
- If two different exercises are active, the one with the newer `savedAt` timestamp becomes the active cloud exercise.

## Testing

1. Configure Supabase and deploy this branch or merge it later.
2. Open Gap Study on a computer, choose **Cloud sync**, and request a sign-in link.
3. Fill several gaps.
4. Open the site on an iPhone, sign in with the same email, and press **Sync now** if the progress is not loaded automatically.
5. Continue from the restored part and verify that the computer receives the later changes.
