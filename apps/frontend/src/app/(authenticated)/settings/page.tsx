'use client';

import { useAuth } from '@/hooks/use-auth';
import { ProfileCard } from '@/components/user/settings/profile-card';
import { ReadingPrefsCard, LibrariesCtaCard } from '@/components/user/settings/reading-prefs-card';
import { AboutCard } from '@/components/user/settings/about-card';

export default function SettingsPage() {
  const { user } = useAuth();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Settings</h1>
        <p className="mt-1 text-muted-foreground">
          Manage your account and preferences
        </p>
      </div>

      <section aria-label="Account" className="space-y-4">
        <ProfileCard name={user?.name} email={user?.email} image={user?.image} isAdmin={user?.isAdmin} />
      </section>

      <section aria-label="Preferences" className="space-y-4">
        <ReadingPrefsCard />
      </section>

      {user?.isAdmin && (
        <section aria-label="Libraries" className="space-y-4">
          <LibrariesCtaCard />
        </section>
      )}

      <section aria-label="About" className="space-y-4">
        <AboutCard />
      </section>
    </div>
  );
}
