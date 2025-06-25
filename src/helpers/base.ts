export const baseFile = `# events.yaml
version: '1'
namespace: true
events:
  # This is the top-level namespace name
  Users:
    # This is the event name
    ProfileUpdated:
      # --- Field Definitions ---

      # A required primitive string
      userId:
        type: string
        required: true

      # An optional primitive number
      age:
        type: number
        required: false

      # A required enum type
      accountStatus:
        type: enum
        required: true
        values:
          - active
          - pending
          - suspended

      # A required array of primitive strings
      tags:
        type: array
        required: true
        items:
          type: string
          required: true # 'required' on items is good practice but doesn't affect the TS type

      # A required object with its own nested fields
      metadata:
        type: object
        required: true
        fields:
          lastLogin:
            type: string
            required: true
          isPremiumUser:
            type: boolean
            required: false

      # An optional array of objects
      loginHistory:
        type: array
        required: false
        items:
          type: object
          required: true
          fields:
            ipAddress:
              type: string
              required: true
            timestamp:
              type: string
              required: true

      # An optional array of enums
      roles:
        type: array
        required: false
        items:
          type: enum
          required: true
          values:
            - reader
            - editor
            - admin

      # A required nested array (array of arrays of strings)
      sessionTrace:
        type: array
        required: true
        items:
          type: array
          required: true
          items:
            type: string
            required: true

      # An optional field using a "pass-through" union type
      deletionDate:
        type: string | null
        required: false
`;
