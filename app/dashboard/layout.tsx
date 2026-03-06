import { redirect } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { auth, signOut } from "@/lib/auth";
import UserSettings from "@/components/layout/UserSettings";

async function handleSignOut() {
  "use server";
  await signOut();
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/api/auth/signin");
  }

  const initials = session.user.name
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase() || "U";

  return (
    <div className="min-h-screen bg-background">
      <nav className="border-b border-border/50 bg-background/60 backdrop-blur-md sticky top-0 z-50">
        <div className="container mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Image
              src="/eeljet.png"
              alt="EelJet"
              width={28}
              height={28}
              className="rounded-md"
            />
            <span className="text-lg font-bold tracking-tight">EelJet</span>
          </Link>
          <div className="flex items-center gap-3">
            <UserSettings user={session.user} onSignOut={handleSignOut} />
          </div>
        </div>
      </nav>
      <main className="container mx-auto px-4 py-12">{children}</main>
    </div>
  );
}
