import "./globals.css";

export const metadata = {
  title: "学习共享空间",
  description: "共享学习账号在线状态、聊天和历史记录",
  icons: {
    icon: "/favicon.png",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
