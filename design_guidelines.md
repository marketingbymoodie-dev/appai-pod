# Design Guidelines: Shopify Print-on-Demand Artwork Customization App

## Design Approach
**Reference-Based**: Drawing from successful product customization platforms (Printful, Printify) combined with Shopify's design language for seamless merchant integration. Focus on intuitive visual customization with professional merchant-facing controls.

## Core Design Principles
1. **Dual Interface Design**: Merchant admin panel (efficiency-focused) + Customer customization interface (experience-focused)
2. **Visual Primacy**: Large preview dominates the interface - product customization is a visual experience
3. **Progressive Disclosure**: Start simple, reveal advanced options as needed

## Typography
- **Primary Font**: Inter (via Google Fonts CDN)
- **Display Font**: Outfit for headings (modern, friendly)
- **Hierarchy**: 
  - H1: 2.5rem (40px), semibold
  - H2: 1.875rem (30px), medium
  - H3: 1.5rem (24px), medium
  - Body: 1rem (16px), regular
  - Small: 0.875rem (14px)

## Layout System
**Spacing Units**: Tailwind units of 2, 4, 6, and 8 (p-2, m-4, gap-6, py-8)
- Consistent 6-unit (24px) gaps between components
- 8-unit (32px) section padding for breathing room

## Application Structure

### Merchant Admin Panel
**Layout**: Sidebar navigation (240px fixed) + main content area (fluid)
- **Sidebar**: Product library, settings, orders, analytics
- **Dashboard**: Grid-based metrics cards (3-column on desktop)
- **Product Management**: Table view with thumbnail previews, status badges, quick actions

### Customer Customization Interface
**Layout**: Split-screen design (60/40 split desktop, stacked mobile)
- **Left Panel (60%)**: Live product preview with mockup rotation
- **Right Panel (40%)**: Customization controls in collapsible sections
  - Upload artwork
  - Choose product size/variant
  - Pattern library
  - Text overlay tools
  - Color adjustments

## Component Library

### Navigation
- **Merchant Nav**: Vertical sidebar with icon + label, active state with accent border-left
- **Customer Nav**: Minimal top bar with logo, cart icon, help

### Forms & Controls
- **File Upload**: Drag-and-drop zone with preview thumbnails
- **Color Picker**: Swatches + custom input
- **Sliders**: Size, opacity, rotation controls with visual feedback
- **Toggle Groups**: Size selection (12"x12", 16"x16", 20"x20")

### Data Display
- **Product Cards**: Square aspect ratio, image + title + price, hover lift effect
- **Order Cards**: Status badge, thumbnail, customer info, actions dropdown
- **Preview Panel**: White/neutral background with subtle shadow, 3:4 aspect ratio

### Buttons
- **Primary**: Solid, rounded corners (rounded-lg), medium size (px-6 py-3)
- **Secondary**: Outline variant
- **Icon Buttons**: Square (40x40px), used for tools palette

### Overlays
- **Modals**: Centered, max-width 600px, backdrop blur
- **Tooltips**: Small, positioned above/below trigger, 4px offset

## Images

### Hero Section (Marketing Page)
**Large Hero Image**: Full-width, 70vh height
- Content: Lifestyle photo showing custom products in use
- Placement: Top of merchant-facing landing page
- Treatment: Subtle gradient overlay (bottom to top) for text legibility
- CTA buttons on hero should have blurred backgrounds

### Product Previews
- Square thumbnails (300x300px) in grids
- Large preview (800x800px) in customization interface
- Mockup renders showing product from multiple angles

### Pattern Library
- Grid of pattern thumbnails (150x150px)
- Hover state shows full-resolution preview in tooltip

## Key Interactions
- **Real-time Preview**: Changes reflect immediately on product mockup
- **Drag-to-Position**: Move uploaded artwork on product surface
- **Pinch-to-Zoom**: On mobile for detailed artwork placement
- **No distracting animations** - smooth transitions only (200ms ease)

## Accessibility
- Minimum touch target: 44x44px
- ARIA labels on all icon-only buttons
- Keyboard navigation for all customization tools
- High contrast mode support for form controls

## Responsive Breakpoints
- Mobile: Single column, stacked layout
- Tablet (768px+): Begin two-column layouts
- Desktop (1024px+): Full split-screen customization interface
- Large (1280px+): Merchant dashboard shows 3-column grids

---

**Design Philosophy**: Professional merchant tools meet delightful customer experience. The merchant interface prioritizes efficiency and data clarity, while the customer customization interface emphasizes visual creativity and ease of use.