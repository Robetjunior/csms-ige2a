-- services/orchestrator-api/migrations/01_extensions.sql

-- Extensões úteis (crie só o que for realmente usar)
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- Caso planeje timeseries/geo:
-- create extension if not exists timescaledb;
-- create extension if not exists postgis;
