/**
 * Route worker entry: exposes RouteEngine (RouteApi) over Comlink. No DOM here.
 * Main-thread side: src/routing/client.ts.
 */
import { expose } from 'comlink';
import { RouteEngine } from './engine';

expose(new RouteEngine());
