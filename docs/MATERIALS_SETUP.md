# Materials Tracking Setup Guide

This guide explains how to set up materials tracking in Odoo for the Field Worker PWA.

## Overview

The PWA's materials feature allows field workers to record materials used on each job. The materials appear:
- On the **Work tab** when a job is "In Progress" or "Completed"
- In a **popup modal** before marking a job as "Completed"

## Odoo Backend Requirements

You need to add two custom methods to the `fsm.order` model in Odoo.

### 1. Create a Custom Module

Create a new Odoo module (e.g., `fsm_materials_api`) with the following structure:

```
fsm_materials_api/
├── __init__.py
├── __manifest__.py
└── models/
    ├── __init__.py
    └── fsm_order.py
```

### 2. Module Manifest

**`__manifest__.py`**:
```python
{
    'name': 'FSM Materials API',
    'version': '16.0.1.0.0',
    'category': 'Field Service',
    'summary': 'API methods for PWA materials tracking',
    'depends': ['fieldservice', 'product'],
    'data': [],
    'installable': True,
    'application': False,
}
```

### 3. Model Extension

**`models/__init__.py`**:
```python
from . import fsm_order
```

**`models/fsm_order.py`**:
```python
from odoo import models, api

class FsmOrder(models.Model):
    _inherit = 'fsm.order'

    @api.model
    def get_material_config(self, order_ids):
        """
        Get available materials for an FSM order based on its categories.
        Called by PWA to populate the materials form.

        Returns: list of dicts with product info and current quantities
        """
        self.ensure_one() if len(order_ids) == 1 else None
        order = self.browse(order_ids[0])

        result = []

        # Option 1: Get materials from order's sale order lines
        if order.sale_id:
            for line in order.sale_id.order_line:
                if line.product_id and line.product_id.type in ('consu', 'product'):
                    result.append({
                        'product_id': line.product_id.id,
                        'product_name': line.product_id.name,
                        'uom_label': line.product_uom.name if line.product_uom else 'ea',
                        'current_qty': self._get_used_qty(order, line.product_id.id),
                    })

        # Option 2: Get materials from a category-based configuration
        # Uncomment and customize if you use category-based material lists
        #
        # for category in order.category_ids:
        #     for product in category.material_product_ids:
        #         if product.id not in [r['product_id'] for r in result]:
        #             result.append({
        #                 'product_id': product.id,
        #                 'product_name': product.name,
        #                 'uom_label': product.uom_id.name if product.uom_id else 'ea',
        #                 'current_qty': self._get_used_qty(order, product.id),
        #             })

        # Option 3: Return a fixed list of common materials
        # Uncomment for testing or simple setups
        #
        # common_products = self.env['product.product'].search([
        #     ('categ_id.name', 'ilike', 'materials'),
        #     ('type', 'in', ('consu', 'product')),
        # ], limit=20)
        # for product in common_products:
        #     result.append({
        #         'product_id': product.id,
        #         'product_name': product.name,
        #         'uom_label': product.uom_id.name if product.uom_id else 'ea',
        #         'current_qty': self._get_used_qty(order, product.id),
        #     })

        return result

    def _get_used_qty(self, order, product_id):
        """
        Get the quantity already recorded for a product on this order.
        Customize based on how you store material usage.
        """
        # Option 1: Check stock moves
        # moves = self.env['stock.move'].search([
        #     ('fsm_order_id', '=', order.id),
        #     ('product_id', '=', product_id),
        #     ('state', '=', 'done'),
        # ])
        # return sum(moves.mapped('quantity_done'))

        # Option 2: Check a custom material usage model
        # usage = self.env['fsm.material.usage'].search([
        #     ('order_id', '=', order.id),
        #     ('product_id', '=', product_id),
        # ], limit=1)
        # return usage.quantity if usage else 0

        # Default: return 0
        return 0

    @api.model
    def save_materials(self, order_ids, lines):
        """
        Save material usage for an FSM order.
        Called by PWA when worker records materials used.

        Args:
            order_ids: list with single order ID
            lines: list of dicts [{'product_id': int, 'quantity': float}, ...]

        Returns: True on success
        """
        order = self.browse(order_ids[0])

        for line in lines:
            product_id = line.get('product_id')
            quantity = line.get('quantity', 0)

            if not product_id or quantity <= 0:
                continue

            # Option 1: Create stock moves (consumes inventory)
            # self._create_material_move(order, product_id, quantity)

            # Option 2: Create custom usage records
            # self._create_usage_record(order, product_id, quantity)

            # Option 3: Add to order notes (simple tracking)
            product = self.env['product.product'].browse(product_id)
            note = f"Material used: {product.name} x {quantity}"
            order.message_post(body=note)

        return True

    def _create_material_move(self, order, product_id, quantity):
        """Create a stock move to consume materials from inventory."""
        product = self.env['product.product'].browse(product_id)

        # Get or create picking for this order
        picking_type = self.env.ref('stock.picking_type_out')
        location_src = self.env.ref('stock.stock_location_stock')
        location_dest = self.env.ref('stock.stock_location_customers')

        move_vals = {
            'name': f"FSM Material: {order.name}",
            'product_id': product_id,
            'product_uom_qty': quantity,
            'product_uom': product.uom_id.id,
            'location_id': location_src.id,
            'location_dest_id': location_dest.id,
            'fsm_order_id': order.id,
        }

        move = self.env['stock.move'].create(move_vals)
        move._action_confirm()
        move._action_assign()
        move.quantity_done = quantity
        move._action_done()

        return move
```

## Configuration Options

### Option A: Sale Order Line Materials

If your FSM orders are linked to sale orders, the default implementation pulls materials from the sale order lines. No additional configuration needed.

### Option B: Category-Based Materials

To assign materials based on FSM categories:

1. Add a Many2many field to `fsm.category`:
```python
class FsmCategory(models.Model):
    _inherit = 'fsm.category'

    material_product_ids = fields.Many2many(
        'product.product',
        string='Available Materials',
        domain=[('type', 'in', ('consu', 'product'))],
    )
```

2. Configure materials for each category in Odoo

### Option C: Product Category Filter

To show all products from a specific product category:

1. Create a product category called "Materials" in Odoo
2. Add your material products to this category
3. Use Option 3 in the code above

## Testing

1. Install the module in Odoo
2. Create a test FSM order with materials (via sale order or category config)
3. Open the order in the PWA
4. Navigate to the Work tab when status is "In Progress"
5. You should see the Materials Used section with stepper controls

## Troubleshooting

### Materials section not showing

1. Check browser console for API errors
2. Verify `get_material_config` returns data:
   ```python
   # In Odoo shell
   order = env['fsm.order'].browse(ORDER_ID)
   print(order.get_material_config([ORDER_ID]))
   ```
3. Ensure job is in "In Progress" or "Completed" stage

### Save not working

1. Check Odoo logs for errors in `save_materials`
2. Verify the PWA user has write access to fsm.order
3. Check if offline - materials queue in IndexedDB

## API Reference

### GET Material Config

**Method:** `fsm.order.get_material_config`
**Args:** `[[order_id]]`
**Returns:**
```json
[
  {
    "product_id": 123,
    "product_name": "Air Filter 20x20x1",
    "uom_label": "ea",
    "current_qty": 0
  },
  {
    "product_id": 456,
    "product_name": "Refrigerant R410A",
    "uom_label": "lbs",
    "current_qty": 2.5
  }
]
```

### POST Save Materials

**Method:** `fsm.order.save_materials`
**Args:** `[[order_id], lines]`
**Lines format:**
```json
[
  {"product_id": 123, "quantity": 2},
  {"product_id": 456, "quantity": 5.5}
]
```
**Returns:** `true` on success
