type Schema = Readonly<Record<string, unknown>>
type Properties = Readonly<Record<string, Schema>>
type Operation = 'assess_context' | 'observe_context' | 'interpret_feedback' | 'judge_candidate'

const text = { type: 'string' }
const value = (...values: string[]): Schema => ({ type: 'string', enum: values })
const object = (properties: Properties): Schema => ({ type: 'object', properties,
  required: Object.keys(properties), additionalProperties: false })
const array = (items: Schema): Schema => ({ type: 'array', items })
const question = object({ question: text, unresolvedScope: text })
const remaining = { anyOf: [{ type: 'null' }, question] }
const fact = { anyOf: [
  object({ lane: value('long_term_interest'), statement: text, stance: value('include', 'exclude') }),
  object({ lane: value('existing_knowledge'), statement: text, epistemic: value('asserted', 'uncertain') }),
] }
const changes = object({ additions: array(fact), replacements: array(object({ target: fact, replacement: array(fact) })) })

// Strict providers require every property of an object to be required. Represent
// optional fields as separate closed variants instead of changing their meaning.
function variants(required: Properties, optional: Properties): Schema[] {
  let alternatives: Properties[] = [required]
  for (const [key, schema] of Object.entries(optional)) {
    alternatives = alternatives.flatMap(fields => [fields, { ...fields, [key]: schema }])
  }
  return alternatives.map(object)
}

/** Describes the existing decoder's wire format; it does not replace validation. */
export function modelResponseSchema(operation: Operation, assessment: boolean, continuation: boolean): Schema {
  let results: Schema[]
  if (operation === 'assess_context') {
    results = [object({ status: value('incomplete') }), object({ status: value('completed'), sufficient: { type: 'boolean' } })]
  } else if (operation === 'judge_candidate') {
    results = [object({ longTermValue: value('pass', 'fail', 'unknown'),
      longTermInterestMatch: value('pass', 'fail', 'unknown', 'not_reached'),
      informationIncrement: value('pass', 'fail', 'unknown', 'not_reached') })]
  } else {
    const required: Properties = continuation ? { remaining } : {}
    const optional: Properties = { ...(!continuation ? { remaining } : {}), resolvedReferenceText: text }
    if (operation === 'observe_context') {
      const context: Properties = { ...required, ...(assessment ? { sufficient: { type: 'boolean' } } : {}) }
      results = [object({ status: value('incomplete') }),
        ...variants({ status: value('ignored'), ...context }, optional),
        ...variants({ status: value('applied'), changes, ...context }, optional)]
    } else {
      const extras = { ...optional, changes }
      results = [object({ status: value('incomplete') }),
        ...variants({ status: value('pass'), ...required }, extras),
        ...variants({ status: value('discarded'), ...required }, extras),
        ...variants({ status: value('needs_input'), remaining: question }, { resolvedReferenceText: text, changes }),
        ...variants({ status: value('completed'), sentiment: value('like'), targetText: text, ...required }, { ...extras, reason: text }),
        ...variants({ status: value('completed'), sentiment: value('dislike'), targetText: text, reason: text, ...required }, extras)]
    }
  }
  return object({ result: { anyOf: results } })
}
