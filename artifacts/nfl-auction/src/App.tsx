import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Redirect,
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
import FormatPreview from '@/pages/FormatPreview';
import { SeasonProvider } from '@/hooks/useSeason';
import './unified-preview.css';

const queryClient = new QueryClient();

function MainRoutes() {
  return (
    <Switch>
      <Route path="/">
        <Redirect to="/results" />
      </Route>
      <Route path="/results" component={Results} />
      <Route path="/mtm">
        <Redirect to={`/analysis${window.location.search}`} />
      </Route>
      <Route path="/analysis" component={MtmTracker} />
      <Route path="/trades" component={Trades} />
      <Route path="/teams" component={Teams} />
      <Route path="/bidders" component={Bidders} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/whats-new" component={WhatsNew} />
      <Route path="/faq" component={Faq} />
      <Route component={NotFound} />
    </Switch>
  );
}

function Router() {
  const [location] = useLocation();
  if (location === '/format-preview') {
    return (
      <RoutedErrorBoundary>
        <FormatPreview />
      </RoutedErrorBoundary>
    );
  }

  return (
    <Switch>
      <Route path="/unified-preview" nest>
        <div className="unified-preview">
          <Shell isPreview>
            <RoutedErrorBoundary>
              <MainRoutes />
            </RoutedErrorBoundary>
          </Shell>
        </div>
      </Route>
      <Route>
        <div className="unified-preview">
          <Shell isPreview>
            <RoutedErrorBoundary>
              <MainRoutes />
            </RoutedErrorBoundary>
          </Shell>
        </div>
      </Route>
    </Switch>
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
