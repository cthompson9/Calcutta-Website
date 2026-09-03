import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

import { Shell } from '@/components/layout/Shell';
import Dashboard from '@/pages/Dashboard';
import Teams from '@/pages/Teams';
import Bidders from '@/pages/Bidders';
import Results from '@/pages/Results';
import Trades from '@/pages/Trades';
import MtmTracker from '@/pages/MtmTracker';
import WhatsNew from '@/pages/WhatsNew';
import Faq from '@/pages/Faq';
import { SeasonProvider } from '@/hooks/useSeason';

const queryClient = new QueryClient();

function Router() {
  return (
    <Shell>
      <RoutedErrorBoundary>
        <Switch>
          <Route path="/" component={Results} />
          <Route path="/mtm" component={MtmTracker} />
          <Route path="/trades" component={Trades} />
          <Route path="/teams" component={Teams} />
          <Route path="/bidders" component={Bidders} />
          <Route path="/dashboard" component={Dashboard} />
          <Route path="/whats-new" component={WhatsNew} />
          <Route path="/faq" component={Faq} />
          <Route component={NotFound} />
        </Switch>
      </RoutedErrorBoundary>
    </Shell>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SeasonProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
        </SeasonProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
