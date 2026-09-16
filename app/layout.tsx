import './globals.css';
import { LanguageProvider } from './providers/language-provider';
export const metadata={title:'Vuryfy',description:'Explainable verification'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang='en'><body><LanguageProvider>{children}</LanguageProvider></body></html>}
