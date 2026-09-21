import './globals.css';
import { LanguageProvider } from './providers/language-provider';
import { PostHogProvider } from './providers/posthog-provider';
export const metadata={title:'Vuryfy',description:'Explainable verification'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang='en'><body><PostHogProvider><LanguageProvider>{children}</LanguageProvider></PostHogProvider></body></html>}
