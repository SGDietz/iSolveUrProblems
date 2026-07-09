import "./globals.css";
import { AuthProvider } from "../src/lib/auth/AuthProvider";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="site-bg flex min-h-screen flex-col text-white justify-center items-center">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
