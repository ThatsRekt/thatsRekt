import { describe, expect, it, afterEach, beforeEach } from 'bun:test'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { DaoFundBanner } from './DaoFundBanner'
import { DAO_FUND_INITIATIVE_URL } from '../lib/daoFund'

const STORAGE_KEY = 'thatsrekt_dao_fund_banner_dismissed_v3'

describe('DaoFundBanner', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it('says thatsRekt was selected and links to the campaign', () => {
    render(<DaoFundBanner />)
    expect(
      screen.getByText(/thatsRekt has been selected for The DAO Fund, an Ethereum security public-good funding program/i),
    ).toBeDefined()
    const link = screen.getByRole('link', { name: /see more/i })
    expect(link.getAttribute('href')).toBe(DAO_FUND_INITIATIVE_URL)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('hides after dismiss and stays hidden', () => {
    const { unmount } = render(<DaoFundBanner />)
    fireEvent.click(screen.getByRole('button', { name: 'dismiss dao fund banner' }))
    expect(screen.queryByLabelText('The DAO Fund selection')).toBeNull()
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1')
    unmount()
    render(<DaoFundBanner />)
    expect(screen.queryByLabelText('The DAO Fund selection')).toBeNull()
  })
})
