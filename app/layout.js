export const metadata = {
  title: 'Think Tree Brand Agent',
  description: 'Slack-native RAG brand intelligence agent'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 40, maxWidth: 760 }}>
        {children}
      </body>
    </html>
  );
}
