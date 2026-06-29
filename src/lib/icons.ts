import {
  Circle, Home, ShoppingCart, ShoppingBag, Utensils, Pizza, Coffee, Wine, Apple,
  Car, Fuel, Bus, Train, Plane, Bike, HeartPulse, Pill, Stethoscope, Shirt,
  Gift, BookOpen, GraduationCap, School, Wifi, Smartphone, Phone, Laptop, Tv,
  Zap, Droplet, Flame, Lightbulb, Dumbbell, Gamepad2, Music, Film, Baby, Dog,
  Cat, Scissors, Wrench, Hammer, Briefcase, Building2, Landmark, CreditCard,
  PiggyBank, Wallet, Banknote, Coins, TrendingUp, Receipt, Bed, Sofa, Umbrella,
  Shield, Key, Star, Heart, Sparkles, Cigarette,
  type LucideIcon,
} from 'lucide-react';

// Curated set for budget categories. Keys are the stable string stored in DB.
export const ICON_MAP: Record<string, LucideIcon> = {
  circle: Circle, home: Home, cart: ShoppingCart, bag: ShoppingBag,
  utensils: Utensils, pizza: Pizza, coffee: Coffee, wine: Wine, apple: Apple,
  car: Car, fuel: Fuel, bus: Bus, train: Train, plane: Plane, bike: Bike,
  health: HeartPulse, pill: Pill, doctor: Stethoscope, shirt: Shirt,
  gift: Gift, book: BookOpen, grad: GraduationCap, school: School,
  wifi: Wifi, phone: Smartphone, call: Phone, laptop: Laptop, tv: Tv,
  zap: Zap, water: Droplet, flame: Flame, bulb: Lightbulb,
  gym: Dumbbell, game: Gamepad2, music: Music, film: Film, baby: Baby,
  dog: Dog, cat: Cat, scissors: Scissors, wrench: Wrench, hammer: Hammer,
  work: Briefcase, building: Building2, bank: Landmark, card: CreditCard,
  piggy: PiggyBank, wallet: Wallet, cash: Banknote, coins: Coins,
  trending: TrendingUp, receipt: Receipt, bed: Bed, sofa: Sofa,
  umbrella: Umbrella, shield: Shield, key: Key, star: Star,
  heart: Heart, sparkles: Sparkles, cigarette: Cigarette,
};

// Ordered list of icon keys for the picker UI.
export const ICON_KEYS = Object.keys(ICON_MAP);

export function getIcon(name?: string | null): LucideIcon {
  return (name && ICON_MAP[name]) || Circle;
}
